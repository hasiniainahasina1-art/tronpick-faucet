const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const EMAIL = process.env.TRONPICK_EMAIL;
const PASSWORD = process.env.TRONPICK_PASSWORD;

// 🔐 PROXY CONFIG
const PROXY = {
    host: '198.23.239.134',
    port: '6540',
    username: 'Finoana123',
    password: 'Finoana123'
};

const delay = (ms) => new Promise(res => setTimeout(res, ms));

const humanDelay = async (min = 1500, max = 5000) => {
    await delay(Math.floor(Math.random() * (max - min) + min));
};

// 🧠 Simulation humaine
async function simulateHuman(page) {
    for (let i = 0; i < 5; i++) {
        await page.mouse.move(
            200 + Math.random() * 800,
            200 + Math.random() * 400
        );
        await humanDelay(300, 800);
    }

    await page.evaluate(() => window.scrollBy(0, 300));
    await humanDelay();
    await page.evaluate(() => window.scrollBy(0, -150));
}

// 🌍 Warmup navigation
async function warmUpNavigation(page) {
    console.log('🌍 Warmup navigation...');

    await page.goto('https://tronpick.io/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    await humanDelay(4000, 8000);
    await simulateHuman(page);
}

// 🔍 Détection blocage
async function detectBlock(page) {
    const html = await page.content();

    if (
        html.includes('cf-challenge') ||
        html.includes('Cloudflare') ||
        html.includes('Just a moment')
    ) {
        return true;
    }

    return false;
}

// 🔘 Trouver bouton login
async function findLoginButton(page) {
    return await page.evaluateHandle(() => {
        const btns = [...document.querySelectorAll('button')];
        return btns.find(b =>
            b.textContent.toLowerCase().includes('log') ||
            b.textContent.toLowerCase().includes('sign')
        );
    });
}

// ✅ Vérifier login
async function isLoggedIn(page) {
    return await page.evaluate(() => {
        return !window.location.href.includes('login');
    });
}

async function run() {
    console.log('🚀 Lancement avec proxy...');

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            `--proxy-server=http://${PROXY.host}:${PROXY.port}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1366,768'
        ]
    });

    const page = await browser.newPage();

    // 🔐 Auth proxy
    await page.authenticate({
        username: PROXY.username,
        password: PROXY.password
    });

    try {
        await page.setViewport({ width: 1366, height: 768 });

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // 🌍 Warmup
        await warmUpNavigation(page);

        console.log('🔐 Accès login...');
        await page.goto('https://tronpick.io/login.php', {
            waitUntil: 'domcontentloaded'
        });

        await humanDelay(3000, 6000);

        if (await detectBlock(page)) {
            throw new Error('Cloudflare détecté');
        }

        // 📧 Email
        const emailInput = await page.$('input[type="email"], input[name="email"]');
        await emailInput.click();
        await page.keyboard.type(EMAIL, { delay: 100 });

        await humanDelay();

        // 🔑 Password
        const passInput = await page.$('input[type="password"]');
        await passInput.click();
        await page.keyboard.type(PASSWORD, { delay: 120 });

        await humanDelay(2000, 4000);

        // 🔘 Login
        const loginBtn = await findLoginButton(page);
        await loginBtn.click();

        console.log('🖱️ Clic login');

        await humanDelay(5000, 9000);

        if (await isLoggedIn(page)) {
            console.log('✅ LOGIN RÉUSSI');
        } else {
            throw new Error('Login échoué');
        }

    } catch (err) {
        console.log('❌', err.message);
    } finally {
        await browser.close();
    }
}

run();
