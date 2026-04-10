const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

const EMAIL = process.env.TRONPICK_EMAIL?.trim().toLowerCase();
const PASSWORD = process.env.TRONPICK_PASSWORD;

const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const PROXY_HOST = '31.59.20.176';
const PROXY_PORT = '6754';

const delay = ms => new Promise(r => setTimeout(r, ms));

/* ================= HUMAN ================= */
async function human(page) {
    for (let i = 0; i < 5; i++) {
        await page.mouse.move(
            Math.random() * 800,
            Math.random() * 600,
            { steps: 20 }
        );
        await delay(300 + Math.random() * 400);
    }
}

/* ================= LOGIN ================= */
async function login(page) {
    await page.goto('https://tronpick.io/login.php', {
        waitUntil: 'networkidle2'
    });

    await delay(3000);

    await page.type('input[type="email"]', EMAIL, { delay: 50 });
    await page.type('input[type="password"]', PASSWORD, { delay: 50 });

    await human(page);

    const loginBtn = await page.evaluateHandle(() => {
        return [...document.querySelectorAll('button')]
            .find(b => b.textContent.toLowerCase().includes('log in'));
    });

    if (!loginBtn) throw new Error('Login bouton introuvable');

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        loginBtn.click()
    ]);

    await delay(5000);

    console.log('✅ Login OK:', page.url());
}

/* ================= FIND CLAIM ================= */
async function findClaimButton(page) {
    return await page.evaluate(() => {
        const els = [...document.querySelectorAll('*')];

        for (const el of els) {
            const txt = (el.textContent || '').trim().toUpperCase();

            if (txt === 'CLAIM' && el.offsetParent !== null) {
                const rect = el.getBoundingClientRect();
                return {
                    x: rect.x + rect.width / 2,
                    y: rect.y + rect.height / 2
                };
            }
        }

        return null;
    });
}

/* ================= CLICK REAL ================= */
async function realClick(page, pos) {
    await page.mouse.move(pos.x, pos.y, { steps: 25 });
    await delay(500);

    await page.mouse.down();
    await delay(100 + Math.random() * 200);
    await page.mouse.up();
}

/* ================= CLAIM ================= */
async function claim(page) {
    await page.goto('https://tronpick.io/faucet.php', {
        waitUntil: 'networkidle2'
    });

    await delay(8000);
    await human(page);

    console.log('🔍 Recherche CLAIM...');

    const pos = await findClaimButton(page);

    if (!pos) {
        return { success: false, message: 'CLAIM introuvable' };
    }

    console.log('📍 Position CLAIM:', pos);

    // écoute réseau
    let success = false;

    const listener = async (res) => {
        const url = res.url().toLowerCase();

        if (url.includes('claim')) {
            const txt = await res.text().catch(() => '');
            if (txt.includes('success')) success = true;
        }
    };

    page.on('response', listener);

    console.log('🔥 CLIC HUMAIN...');
    await realClick(page, pos);

    await delay(10000);

    page.off('response', listener);

    const text = await page.evaluate(() => document.body.innerText.toLowerCase());

    if (success || text.includes('claimed')) {
        return { success: true, message: 'CLAIM SUCCESS' };
    }

    if (text.includes('wait') || text.includes('cooldown')) {
        return { success: false, message: 'COOLDOWN' };
    }

    return { success: false, message: 'Échec CLAIM' };
}

/* ================= MAIN ================= */
(async () => {
    let browser;

    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: true,
            proxy: {
                host: PROXY_HOST,
                port: PROXY_PORT,
                username: PROXY_USERNAME,
                password: PROXY_PASSWORD
            }
        });

        browser = br;

        await page.setViewport({ width: 1280, height: 720 });

        await login(page);

        const result = await claim(page);

        console.log('📊 RESULT:', result);

    } catch (e) {
        console.log('❌ ERREUR:', e.message);
    } finally {
        if (browser) await browser.close();
    }
})();
