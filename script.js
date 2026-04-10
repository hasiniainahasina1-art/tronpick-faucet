const { connect } = require('puppeteer-real-browser');

const EMAIL = process.env.TRONPICK_EMAIL?.trim().toLowerCase();
const PASSWORD = process.env.TRONPICK_PASSWORD;

const PROXY_HOST = '31.59.20.176';
const PROXY_PORT = '6754';
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;

const delay = ms => new Promise(r => setTimeout(r, ms));

/* ================= NAV ================= */
async function safeGoto(page, url) {
    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    }).catch(() => {});

    await delay(5000);
}

/* ================= LOGIN (VERSION STABLE RESTAURÉE) ================= */
async function login(page) {
    console.log('🌐 LOGIN...');

    await safeGoto(page, 'https://tronpick.io/login.php');

    await delay(6000);

    // 🔥 ATTEND JUSTE LES INPUTS SANS COMPLEXITÉ
    await page.waitForSelector('input[type="password"]', { timeout: 60000 });

    const email = await page.$(
        'input[type="email"], input[name="email"], input[type="text"]'
    );

    const pass = await page.$('input[type="password"]');

    if (!email || !pass) {
        throw new Error('❌ Inputs login introuvables');
    }

    await email.click({ clickCount: 3 });
    await page.keyboard.type(EMAIL, { delay: 60 });

    await delay(500);

    await pass.click({ clickCount: 3 });
    await page.keyboard.type(PASSWORD, { delay: 60 });

    const loginBtn = await page.evaluateHandle(() => {
        return [...document.querySelectorAll('button, input')]
            .find(b => (b.textContent || b.value || '').toLowerCase().includes('log'));
    });

    if (!loginBtn) throw new Error('❌ bouton login introuvable');

    await loginBtn.click().catch(() => {});

    await delay(8000);

    console.log('✅ LOGIN OK');
}

/* ================= DEBUG BOUTONS ================= */
async function debugButtons(page) {
    console.log('🔍 BOUTONS ACTIFS :');

    const buttons = await page.evaluate(() => {
        return [...document.querySelectorAll('button, a, div, input')]
            .map(el => {
                const text = (el.textContent || el.value || '').trim();
                const r = el.getBoundingClientRect();

                return {
                    text,
                    visible: el.offsetParent !== null,
                    w: r.width,
                    h: r.height,
                    x: r.x,
                    y: r.y
                };
            })
            .filter(b =>
                b.text &&
                b.visible &&
                b.w > 40 &&
                b.h > 20
            );
    });

    buttons.forEach((b, i) => {
        console.log(`👉 ${i + 1}. "${b.text}"`);
    });

    return buttons;
}

/* ================= FIND ACTION BUTTON ================= */
async function findActionButton(page) {
    return await page.evaluate(() => {
        const keywords = ['claim', 'reward', 'roll', 'collect', 'get', 'spin'];

        const els = [...document.querySelectorAll('button, a, div')];

        for (const el of els) {
            const txt = (el.textContent || '').toLowerCase();
            const r = el.getBoundingClientRect();

            if (!txt) continue;
            if (r.width < 50 || r.height < 20) continue;
            if (el.offsetParent === null) continue;

            if (keywords.some(k => txt.includes(k))) {
                return {
                    x: r.x + r.width / 2,
                    y: r.y + r.height / 2,
                    text: txt
                };
            }
        }

        return null;
    });
}

/* ================= CLICK ROBUSTE ================= */
async function click(page, pos) {
    try {
        await page.mouse.move(pos.x, pos.y, { steps: 20 });
        await delay(200);

        await page.mouse.click(pos.x, pos.y, {
            delay: 120
        });

        console.log('🔥 CLICK:', pos.text);

    } catch (e) {
        console.log('⚠️ fallback click JS');

        await page.evaluate(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            if (el) el.click();
        }, pos);
    }
}

/* ================= CLAIM ================= */
async function claim(page) {
    console.log('🚰 FAUCET...');

    await safeGoto(page, 'https://tronpick.io/faucet.php');

    await delay(6000);

    await debugButtons(page);

    console.log('🔍 recherche bouton...');

    let pos = null;

    for (let i = 0; i < 6; i++) {
        pos = await findActionButton(page);

        if (pos) break;

        console.log('⏳ retry...');
        await delay(3000);
    }

    if (!pos) {
        return { success: false, message: '❌ bouton introuvable' };
    }

    let success = false;

    page.on('response', async res => {
        if (res.url().includes('claim')) {
            const txt = await res.text().catch(() => '');
            if (txt.includes('success')) success = true;
        }
    });

    await click(page, pos);

    await delay(10000);

    const text = await page.evaluate(() =>
        document.body.innerText.toLowerCase()
    );

    if (success || text.includes('claimed')) {
        return { success: true, message: 'SUCCESS' };
    }

    if (text.includes('wait') || text.includes('cooldown')) {
        return { success: false, message: 'COOLDOWN' };
    }

    return { success: false, message: 'FAILED' };
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

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false
            });
        });

        await login(page);

        const result = await claim(page);

        console.log('🏁 RESULT FINAL:', result);

    } catch (e) {
        console.log('❌ ERROR:', e.message);
    } finally {
        if (browser) await browser.close();
    }
})();
