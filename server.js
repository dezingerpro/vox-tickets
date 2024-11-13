const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

let sessionCookies = null; // Store session cookies globally

// Function to log in and save session cookies
async function initLogin() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
  
  const page = await browser.newPage();

  try {
    await page.goto('https://wave.live/users/log_in', { waitUntil: 'networkidle2' });
    console.log("Opened login page.");

    await page.type('input[name="user[email]"]', 'ben@voxcity.com');
    await page.type('input[name="user[password]"]', 'VoxCity4Ben@2023!');
    
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' })
    ]);
    console.log("Login form submitted.");

    const loginSuccess = await page.$('a[href="/users/log_out"]');
    if (!loginSuccess) {
      console.log("Login failed: Logout button not found.");
      return false;
    }
    console.log("Logged in successfully.");

    // Save cookies for future requests
    sessionCookies = await page.cookies();
    console.log("Session cookies saved.");

    await browser.close();
    return true;
  } catch (error) {
    console.error("Login failed:", error);
    await browser.close();
    return false;
  }
}

// API endpoint to download voucher PDF
app.post('/download-voucher-pdf', async (req, res) => {
  const { bookingCode } = req.body;

  if (!bookingCode) {
    console.log("No booking code provided.");
    return res.status(400).json({ error: 'Booking code is required' });
  }

  console.log(`Received booking code: ${bookingCode}`);

  // If session cookies are missing, attempt to log in again
  if (!sessionCookies) {
    console.log("Session expired or not found. Logging in again...");
    const loginSuccessful = await initLogin();
    if (!loginSuccessful) {
      return res.status(403).json({ error: 'Login failed' });
    }
  }

  try {
    // Convert booking code to booking number
    const bookingNumber = convertBookingCode(bookingCode);
    const voucherUrl = `https://wave.live/support/bookings/${bookingNumber}/print_voucher`;
    console.log(`Directly downloading PDF from voucher URL: ${voucherUrl}`);

    // Use stored cookies for authentication
    const cookieString = sessionCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

    // Download the PDF with Axios using saved cookies
    const pdfFilePath = path.join(__dirname, `voucher_${bookingNumber}.pdf`);
    const response = await axios.get(voucherUrl, {
      headers: { Cookie: cookieString },
      responseType: 'arraybuffer'  // Ensures the response is treated as binary data
    });

    // Save PDF to file and send as response
    fs.writeFileSync(pdfFilePath, response.data);
    console.log(`PDF saved at: ${pdfFilePath}`);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=voucher.pdf',
    });
    res.send(response.data);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ error: 'An error occurred while generating the PDF' });
  }
});

// Convert booking code to booking number
function convertBookingCode(bookingCode) {
  if (!bookingCode.startsWith('VOX') || bookingCode.length < 7) {
    console.log("Invalid booking code format.");
    throw new Error("Invalid booking code format.");
  }

  const codeChars = bookingCode.slice(-4).toUpperCase();
  const base36Chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let value = 0;

  for (let i = 0; i < codeChars.length; i++) {
    const digitValue = base36Chars.indexOf(codeChars[i]);
    if (digitValue === -1) {
      console.log("Invalid character in booking code:", codeChars[i]);
      throw new Error("Invalid character in booking code.");
    }
    value += digitValue * Math.pow(36, 3 - i);
  }

  const bookingNumber = value - 658;
  console.log(`Converted booking code ${bookingCode} to booking number: ${bookingNumber}`);
  return bookingNumber;
}

// Endpoint to get customer details
app.post('/get-customer-details', async (req, res) => {
  const { date, option_id } = req.body;
  const url = `https://wave.live/book/forecast/detail?date=${date}&option_id=${option_id}`;

  // Ensure sessionCookies are available
  if (!sessionCookies) {
    console.log("Session expired or not found. Logging in again...");
    const loginSuccessful = await initLogin();
    if (!loginSuccessful) {
      return res.status(403).json({ error: 'Login failed' });
    }
  }

  console.log("Fetching customer details from:", url);

  try {
    // Create cookie string from session cookies
    const cookieString = sessionCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

    // Make an authenticated request to the URL with cookies
    const { data } = await axios.get(url, {
      headers: { Cookie: cookieString }
    });

    const $ = cheerio.load(data);
    const customers = [];

    // Parse customer details from HTML table
    $('table.table-striped tbody tr').each((index, element) => {
      const bookingId = $(element).find('td').eq(0).text().trim();
      const provider = $(element).find('td').eq(1).text().trim();
      const dateTime = $(element).find('td').eq(2).text().trim();
      const guestName = $(element).find('td').eq(3).contents().first().text().trim();
      const email = $(element).find('td').eq(3).find('.text-primary').text().trim();
      const phone = $(element).find('td').eq(3).find('.text-success').text().trim();
      const pax = $(element).find('td').eq(4).text().trim();

      customers.push({
        bookingId,
        provider,
        dateTime,
        guestName,
        email,
        phone,
        pax
      });
    });

    res.json({ customers });
  } catch (error) {
    console.error("Error fetching customer details:", error);
    res.status(500).json({ error: 'Failed to fetch customer details' });
  }
});

// Endpoint to get the booking forecast for today and upcoming dates
app.get('/get-booking-forecast', async (req, res) => {
  const forecastUrl = 'https://wave.live/book/forecast';

  // Ensure sessionCookies are available
  if (!sessionCookies) {
    console.log("Session expired or not found. Logging in again...");
    const loginSuccessful = await initLogin();
    if (!loginSuccessful) {
      return res.status(403).json({ error: 'Login failed' });
    }
  }

  try {
    // Create cookie string from session cookies
    const cookieString = sessionCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

    // Make an authenticated request to the forecast page with cookies
    const { data } = await axios.get(forecastUrl, {
      headers: { Cookie: cookieString }
    });

    const $ = cheerio.load(data);
    const bookings = [];

    // Parse forecast details
    $('.block-content .row').each((i, element) => {
      const date = $(element).find('.font-size-h5 strong').text().trim();
      const day = $(element).find('.font-size-h5 .text-muted').text().trim();

      const products = [];
      $(element).find('table tbody tr').each((j, productElem) => {
        const productName = $(productElem).find('td').first().text().trim();
        const bookingsCount = $(productElem).find('td.text-right').first().text().trim();
        const detailLink = $(productElem).find('td a').attr('href');

        // Only add if the detail link exists
        if (detailLink) {
          const fullDetailLink = `https://wave.live${detailLink}`;
          products.push({ productName, bookingsCount, detailLink: fullDetailLink });
        }
      });

      bookings.push({ date, day, products });
    });

    res.json({ bookings });
  } catch (error) {
    console.error("Error fetching booking forecast data:", error);
    res.status(500).json({ error: 'Failed to fetch booking forecast data' });
  }
});

// Start the server and perform initial login
app.listen(PORT, async () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  const loginSuccessful = await initLogin();
  if (!loginSuccessful) {
    console.log("Initial login failed. Please check credentials.");
  }
});
