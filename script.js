const puppeteer = require('puppeteer-extra');
const Stealth = require('puppeteer-extra-plugin-stealth');

puppeteer.use(Stealth());

const EMAIL = process.env.TRONPICK_EMAIL;
const PASSWORD = process.env.TRONPICK_PASSWORD;

// 🔁 liste proxies
const proxies = [
    "http://user:pass@host1:port",
    "http://user:pass@host2:port",
    "http://user:pass@host3:port"
];

const delay = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(Math.random() * (b - a) + a);

function getRandomProxy() {
    return proxies[Math.floor(Math.random() * proxies.length)];
}

// 🎭 comportement humain variable
async function humanBehavior(page) {
    await page.mouse.move(rand(100, 800), rand(100, 600), { steps: rand(10, 30) });
    await delay(rand(300, 1500));

    if (Math.random() > 0.5) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight / 2));
    }

    await delay(rand(500, 2000));
}

// ⌨️ typing humain
async function humanType(page, selector, text) {
    await page.click(selector);

    for (let char of text) {
        await page.keyboard.type(char);
        await delay(rand(50, 180));
    }
}

// 🔍 détecter blocage
async function isBlocked(page) {
    const content = await page.content();

    return content.includes("captcha") ||
           content.includes("verify you are human") ||
           content.includes("Cloudflare");
}

// 🔐 tentative login
async function attemptLogin(attempt) {

    const proxy = getRandomProxy();

    console.log(`\n🚀 Tentative ${attempt} avec proxy: ${proxy}`);

    const browser = await puppeteer.launch({
        headless: false,
        args: [`--proxy-server=${proxy}`],
        userDataDir: `./profile_${attempt}`
    });

    const page = await browser.newPage();

    try {

        await page.goto('https://tronpick.io/login.php', {
            waitUntil: 'domcontentloaded'
        });

        await humanBehavior(page);

        await humanType(page, 'input[type="email"]', EMAIL);
        await delay(rand(800, 2000));

        await humanType(page, 'input[type="password"]', PASSWORD);
        await delay(rand(1000, 2500));

        // 👉 pause variable avant login
        await delay(rand(2000, 5000));

        const btns = await page.$$('button, input[type="submit"]');

        for (let btn of btns) {
            const txt = await page.evaluate(el => el.innerText || el.value, btn);
            if (txt && txt.toLowerCase().includes('log')) {
                await btn.click();
                break;
            }
        }

        await page.waitForNavigation({ timeout: 20000 }).catch(() => {});
        await delay(5000);

        const url = page.url();

        if (!url.includes('login')) {
            console.log('✅ SUCCÈS');
            await browser.close();
            return true;
        }

        if (await isBlocked(page)) {
            console.log('🚫 Bloqué par Cloudflare');
        }

        await browser.close();
        return false;

    } catch (e) {
        console.log('❌ Erreur:', e.message);
        await browser.close();
        return false;
    }
}

// 🔁 retry intelligent
(async () => {

    const MAX_RETRY = 5;

    for (let i = 1; i <= MAX_RETRY; i++) {

        const success = await attemptLogin(i);

        if (success) {
            console.log('🎉 LOGIN FINAL RÉUSSI');
            return;
        }

        // 🧠 backoff intelligent
        const waitTime = rand(5000, 15000) * i;

        console.log(`⏳ Attente ${waitTime / 1000}s avant retry...`);
        await delay(waitTime);
    }

    console.log('❌ ÉCHEC TOTAL APRÈS PLUSIEURS TENTATIVES');

})();
