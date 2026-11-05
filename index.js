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

async function fetchCheapestLeg(origin, dest, dates) {
    let cheapest = { price: Infinity, date: '' };

    for (const date of dates) {
        try {
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
                if (lowest < cheapest.price) {
                    cheapest.price = lowest;
                    cheapest.date = date;
                }
            }
        } catch (err) {
            console.error(`Error fetching ${origin}->${dest} on ${date}:`, err.message);
        }
    }
    return cheapest;
}

async function checkFlexibleFlights() {
    console.log('Scanning flexible date windows for both legs...');

    const outboundDates = getDatesInRange(config.outboundStart, config.outboundEnd);
    const returnDates = getDatesInRange(config.returnStart, config.returnEnd);

    // Find cheapest outbound leg (BLR -> DBG)
    const bestOutbound = await fetchCheapestLeg(config.origin, config.destination, outboundDates);
    
    // Find cheapest return leg (PAT -> BLR)
    const bestReturn = await fetchCheapestLeg(config.returnOrigin, config.returnDestination, returnDates);

    if (bestOutbound.price === Infinity || bestReturn.price === Infinity) {
        console.log('Could not fetch valid fares for one or both legs.');
        return;
    }

    const totalCost = bestOutbound.price + bestReturn.price;
    console.log(`\n--- Current Best Found ---`);
    console.log(`✈️ Outbound (${config.origin} ➔ ${config.destination} on ${bestOutbound.date}): ₹${bestOutbound.price} (Max target: ₹${config.maxOutboundPrice})`);
    console.log(`✈️ Return (${config.returnOrigin} ➔ ${config.returnDestination} on ${bestReturn.date}): ₹${bestReturn.price} (Max target: ₹${config.maxReturnPrice})`);
    console.log(`💰 Total Combined: ₹${totalCost}\n`);

    // Check if EITHER leg meets its separate target criteria
    const outboundMet = bestOutbound.price <= config.maxOutboundPrice;
    const returnMet = bestReturn.price <= config.maxReturnPrice;

    if (outboundMet || returnMet) {
        const message = `🚨 **Flight Deal Alert (Target Met on at least one leg)!**\n\n` +
            `✈️ **Outbound:** ${config.origin} ➔ ${config.destination} (${bestOutbound.date}) ➔ **₹${bestOutbound.price}** ${outboundMet ? '✅ (Target Met)' : '(Above Target)'}\n` +
            `✈️ **Return:** ${config.returnOrigin} ➔ ${config.returnDestination} (${bestReturn.date}) ➔ **₹${bestReturn.price}** ${returnMet ? '✅ (Target Met)' : '(Above Target)'}\n` +
            `💰 **Total Trip Cost:** ₹${totalCost}`;

        await sendAlert(message);
    } else {
        console.log('Both legs are still above your individual target prices. No alert sent.');
    }
}

async function sendAlert(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown'
    });
    console.log('Alert notification sent successfully!');
}

checkFlexibleFlights();