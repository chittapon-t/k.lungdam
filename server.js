require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Init Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

// Upload Config (Memory Storage for forwarding to Supabase Storage)
const upload = multer({ storage: multer.memoryStorage() });

// --- SERVICES ---

const calculatePrice = (roomType, pax) => {
    if (roomType === 'homestay') return pax >= 6 ? 2200 : 1600;
    if (roomType === 'glamping') {
        const extra = Math.max(0, pax - 2);
        return 1200 + (extra * 350);
    }
    if (roomType === 'camping_ground') return pax * 150;
    if (roomType === 'river_house') return 1400;
    if (roomType === 'field_tent') return 700;
    return 0;
};

const sendLineFlex = async (userId, altText, flexContent) => {
    try {
        await axios.post('[https://api.line.me/v2/bot/message/push](https://api.line.me/v2/bot/message/push)', {
            to: userId,
            messages: [{ type: 'flex', altText: altText, contents: flexContent }]
        }, {
            headers: { 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` }
        });
    } catch (error) {
        console.error('Line Error:', error.response?.data);
    }
};

// --- ROUTES ---

// 1. Create Booking
app.post('/api/bookings', upload.single('slip'), async (req, res) => {
    try {
        const { userId, userJson, bookingDataJson } = req.body;
        const user = JSON.parse(userJson);
        const bookingData = JSON.parse(bookingDataJson);
        const file = req.file;

        // 1. Upsert Customer
        await supabase.from('customers').upsert({
            line_user_id: user.userId,
            display_name: user.displayName,
            picture_url: user.pictureUrl
        });

        // 2. Upload Slip to Supabase Storage (Bucket must be created)
        let slipUrl = '';
        if (file) {
            const fileName = `${Date.now()}_${userId}.jpg`;
            const { data, error } = await supabase.storage.from('slips').upload(fileName, file.buffer, { contentType: file.mimetype });
            if (!error) {
                const { data: publicUrl } = supabase.storage.from('slips').getPublicUrl(fileName);
                slipUrl = publicUrl.publicUrl;
            }
        }

        // 3. Insert Booking
        const { data: booking, error: bError } = await supabase.from('bookings').insert({
            customer_id: userId,
            check_in: bookingData.dates.start,
            check_out: bookingData.dates.end,
            total_price: bookingData.total,
            deposit_amount: bookingData.deposit,
            slip_url: slipUrl,
            status: 'pending'
        }).select().single();

        if (bError) throw bError;

        // 4. Insert Items (Rooms & Food) logic here...
        // (ละไว้ในฐานที่เข้าใจ: Loop bookingData.rooms -> insert booking_items)

        // 5. Notify Admin (Flex Message)
        // สร้าง Flex Message แจ้งแอดมินพร้อมปุ่ม Confirm
        
        res.json({ success: true, bookingId: booking.id });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// 2. LINE Webhook
app.post('/webhook', (req, res) => {
    const events = req.body.events;
    events.forEach(async event => {
        if (event.type === 'postback') {
            const data = new URLSearchParams(event.postback.data);
            const action = data.get('action');
            const bookingId = data.get('id');

            if (action === 'confirm') {
                await supabase.from('bookings').update({ status: 'confirmed' }).eq('id', bookingId);
                // Reply to Admin & Push to User
            }
        }
    });
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
