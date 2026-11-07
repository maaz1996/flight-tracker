require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// Load keys from comma-separated string, filtering out empty or placeholder entries
let rawKeys = process.env.SEARCHAPI_KEY ? process.env.SEARCHAPI_KEY.split(',').map(k => k.trim()).filter(Boolean) : [];
let apiKeys = rawKeys.filter(k => k.length > 10 && !k.includes('placeholder') && !k.includes('here'));

let currentKeyIndex = 0;

function getActiveKey() {
    if (apiKeys.length === 0) {
        throw new Error("No valid SearchApi keys provided in SEARCHAPI_KEY environment variable.");
    }
    return apiKeys[currentKeyIndex];
}

function rotateKey() {
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
    console.log(`⚠️ Rotating to next SearchApi key (Index: ${currentKeyIndex + 1}/${apiKeys.length})...`);
}

function getDatesInRange(startDate, endDate) {
    const dates = [];
    let currentDate = new Date(startDate);
    const stopDate = new Date(endDate);
    
    while (currentDate <= stopDate) {
        dates.push(currentDate.toISOString().split('T')[0]);
        currentDate.setDate(currentDate.getDate() + 1);
    }
    return dates;
}

// Function to fetch updated quotas for all active keys after requests complete
async function fetchPostRunQuotas() {
    const keyQuotas = {};

    // FIXED: Dynamically loops through all loaded keys instead of a hardcoded limit
    for (let i = 0; i < apiKeys.length; i++) {
        const key = apiKeys[i];
        const keyLabel = `Key #${i + 1}`;
        try {
            const response = await axios.get('https://www.searchapi.io/api/v1/me', {
                params: { api_key: key }
            });
            
            const data = response.data || {};
            const accountData = data.account || {};
            
            const remaining = accountData.remaining_credits ?? data.remaining_credits;
            const allowance = accountData.monthly_allowance ?? data.monthly_allowance;
            
            if (remaining !== undefined) {
                let quotaText = `${remaining} remaining`;
                if (allowance !== undefined && allowance > 0) {
                    quotaText += ` of ${allowance}`;
                }
                keyQuotas[keyLabel] = quotaText;
            } else {
                keyQuotas[keyLabel] = 'Active (Quota unverified)';
            }
        } catch (err) {
            keyQuotas[keyLabel] = 'Active / Unverified';
        }
    }
    return keyQuotas;
}

async function fetchWithRetry(url, params) {
    let attempts = 0;
    while (attempts < apiKeys.length) {
        try {
            const activeKey = getActiveKey();
            params.api_key = activeKey;

            const response = await axios.get(url, { params });
            return response.data;
        } catch (err) {
            const status = err.response?.status;
            console.error(`API request failed with key index ${currentKeyIndex + 1} (Status: ${status}):`, err.message);
            
            if (status === 429 || status === 401 || status === 403 || status === 402) {
                rotateKey();
                attempts++;
            } else {
                throw err;
            }
        }
    }
    throw new Error("All API keys failed or exhausted during execution.");
}

async function fetchAllLegPrices(origin, dest, dates) {
    const legResults = [];

    for (const date of dates) {
        try {
            const data = await fetchWithRetry('https://www.searchapi.io/api/v1/search', {
                engine: 'google_flights',
                departure_id: origin,
                arrival_id: dest,
                outbound_date: date,
                flight_type: 'one_way',
                currency: 'INR',
                hl: 'en'
            });

            const allFlights = [
                ...(data.best_flights || []),
                ...(data.other_flights || [])
            ];

            if (allFlights.length > 0) {
                const validPrices = allFlights.map(f => f.price).filter(p => typeof p === 'number' && !isNaN(p));
                
                if (validPrices.length > 0) {
                    const lowest = Math.min(...validPrices);
                    legResults.push({ date, price: lowest });
                } else {
                    legResults.push({ date, price: null });
                }
            } else {
                legResults.push({ date, price: null });
            }
        } catch (err) {
            console.error(`Error fetching ${origin}->${dest} on ${date}:`, err.message);
            legResults.push({ date, price: null });
        }
    }
    return legResults;
}

async function checkFlexibleFlights() {
    console.log(`Loaded ${apiKeys.length} active API key(s) into rotation pool.`);
    if (apiKeys.length === 0) {
        console.error("🚨 CRITICAL: No operational SearchApi keys available.");
        return;
    }

    console.log('Scanning flexible date windows for both legs...');

    const outboundDates = getDatesInRange(config.outboundStart, config.outboundEnd);
    const returnDates = getDatesInRange(config.returnStart, config.returnEnd);

    const outboundResults = await fetchAllLegPrices(config.origin, config.destination, outboundDates);
    const returnResults = await fetchAllLegPrices(config.returnOrigin, config.returnDestination, returnDates);

    console.log('Flight scans complete. Fetching updated post-run quotas...');
    const keyQuotas = await fetchPostRunQuotas();

    let message = `📊 **Flight Price Tracker Update**\n\n`;

    message += `✈️ **Outbound (${config.origin} ➔ ${config.destination}):**\n`;
    outboundResults.forEach(item => {
        const status = item.price !== null ? `₹${item.price}` : `No flights / Error`;
        const targetMark = (item.price !== null && item.price <= config.maxOutboundPrice) ? ' ✅' : '';
        message += `• ${item.date}: **${status}**${targetMark}\n`;
    });

    message += `\n✈️ **Return (${config.returnOrigin} ➔ ${config.returnDestination}):**\n`;
    returnResults.forEach(item => {
        const status = item.price !== null ? `₹${item.price}` : `No flights / Error`;
        const targetMark = (item.price !== null && item.price <= config.maxReturnPrice) ? ' ✅' : '';
        message += `• ${item.date}: **${status}**${targetMark}\n`;
    });

    message += `\n_Targets: Outbound ≤₹${config.maxOutboundPrice} | Return ≤₹${config.maxReturnPrice}_\n\n`;

    // Append API Key Quotas section to Telegram message post-run
    message += `🔑 **API Quota Status (Post-Run):**\n`;
    for (const [keyName, status] of Object.entries(keyQuotas)) {
        message += `• ${keyName}: ${status}\n`;
    }

    await sendAlert(message);
}

async function sendAlert(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown'
    });
    console.log('Telegram notification sent successfully!');
}

checkFlexibleFlights();