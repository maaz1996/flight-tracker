require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

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

async function checkApiCredits() {
    try {
        const response = await axios.get('https://serpapi.com/account', {
            params: { api_key: process.env.SERPAPI_KEY }
        });
        const searchesRemaining = response.data.plan_searches_left;
        console.log(`SerpApi credits remaining: ${searchesRemaining}`);
        
        if (searchesRemaining !== undefined && searchesRemaining <= 0) {
            await sendAlert(`🚨 **WARNING: SerpApi Credits Exhausted!**\n\nYou have 0 searches left on your current SerpApi account. Please rotate your API key.`);
            return false;
        }
    } catch (err) {
        console.error('Could not check SerpApi account quota:', err.message);
    }
    return true;
}

async function fetchAllLegPrices(origin, dest, dates) {
    const legResults = [];

    for (const date of dates) {
        try {
            // FIXED: Using actual SerpApi Google Flights endpoint
            const response = await axios.get('https://serpapi.com/search.json', {
                params: {
                    engine: 'google_flights',
                    departure_id: origin,
                    arrival_id: dest,
                    outbound_date: date,
                    type: 2, // One-way search per leg
                    currency: 'INR',
                    hl: 'en',
                    api_key: process.env.SERPAPI_KEY
                }
            });

            const allFlights = [
                ...(response.data.best_flights || []),
                ...(response.data.other_flights || [])
            ];

            if (allFlights.length > 0) {
                const lowest = Math.min(...allFlights.map(f => f.price));
                legResults.push({ date, price: lowest });
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
    console.log('Checking SerpApi credit status before running scan...');
    const hasCredits = await checkApiCredits();
    if (!hasCredits) return;

    console.log('Scanning flexible date windows for both legs...');

    const outboundDates = getDatesInRange(config.outboundStart, config.outboundEnd);
    const returnDates = getDatesInRange(config.returnStart, config.returnEnd);

    // Fetch prices for all dates in both ranges
    const outboundResults = await fetchAllLegPrices(config.origin, config.destination, outboundDates);
    const returnResults = await fetchAllLegPrices(config.returnOrigin, config.returnDestination, returnDates);

    // PRINT OBJECTS TO THE RUNNER LOGS FOR DEBUGGING
    console.log('--- OUTBOUND RESULTS OBJECT ---');
    console.log(JSON.stringify(outboundResults, null, 2));

    console.log('--- RETURN RESULTS OBJECT ---');
    console.log(JSON.stringify(returnResults, null, 2));

    // Build the Telegram message report
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

    message += `\n_Targets: Outbound ≤₹${config.maxOutboundPrice} | Return ≤₹${config.maxReturnPrice}_`;

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