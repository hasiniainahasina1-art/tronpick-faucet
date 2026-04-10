const { connect } = require('puppeteer-real-browser');

const EMAIL = process.env.TRONPICK_EMAIL?.trim().toLowerCase();
const PASSWORD = process.env.TRONPICK_PASSWORD;

const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;

const PROXY_HOST = '31.59.20.176';
const PROXY_PORT = '6754';

const delay = ms => new Promise(r => setTimeout(r, ms));

/* ================= SAFE GOTO ================= */
async function safeGoto(page, url) {
    console.log('🌐 Navigation:', url);

    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    }).catch(() => console.log('⚠️ timeout ignoré'));

    await delay(6000);
}

/* ================= HUMAN ================= */
async function human(page) {
    for (let i = 0; i < 5; i++) {
        await page.mouse.move(
            Math.random() * 900,
            Math.random() * 700,
            { steps: 25 }
        );
        await delay(300);
    }
}

/* ================= LOGIN ================= */
async function login(page) {
    await safeGoto(page, 'https://tronpick.io/login.php');

    const email = await page.waitForSelector('input', { timeout: 30000 });
    await page.type('input[type="email"], input[name="email"], input[type="text"]', EMAIL, { delay: 60 });

    await delay(500);

    await page.type('input[type="password"], input[name="password"]', PASSWORD, { delay: 60 });

    await human(page);

    const loginBtn = await page.evaluateHandle(() => {
        return [...document.querySelectorAll('button')]
            .find(b => (b.textContent || '').toLowerCase().includes('log'));
    });

    if (!loginBtn) throw new Error('Login button introuvable');

    await loginBtn.click().catch(() => console.log('⚠️ fallback click login'));

    await delay(8000);

    console.log('✅ LOGIN OK');
}

/* ================= DEBUG BUTTONS ================= */
async function debugButtons(page) {
    console.log('🔍 ANALYSE BOUTONS ACTIFS...');

    const buttons = await page.evaluate(() => {
        return [...document.querySelectorAll('button, a, div, input')]
            .map(el => {
                const text = (el.textContent || el.value || '').trim();
                const r = el.getBoundingClientRect();

                return {
                    text,
                    tag: el.tagName,
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
        console.log(`👉 ${i + 1}. [${b.tag}] "${b.text}"`);
    });

    return buttons;
}

/* ================= FIND CLAIM ================= */
async function findClaim(page) {
    return await page.evaluate(() => {
        const keywords = ['claim', 'reward', 'roll', 'collect', 'get'];

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

/* ================= CLICK SAFE ================= */
async function safeClick(page, pos) {
    try {
        await page.mouse.move(pos.x, pos.y, { steps: 20 });
        await delay(300);

        await page.mouse.click(pos.x, pos.y, {
            delay: 100 + Math.random() * 150
        });

        console.log('🔥 CLICK OK:', pos.text);

    } catch (e) {
        console.log('⚠️ fallback JS click');

        await page.evaluate(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            if (el) el.click();
        }, pos);
    }
}

/* ================= CLAIM ================= */
async function claim(page) {
    await safeGoto(page, 'https://tronpick.io/faucet.php');

    await delay(8000);
    await human(page);

    await debugButtons(page);

    console.log('🔍 Recherche CLAIM...');

    let pos = null;

    for (let i = 0; i < 6; i++) {
        pos = await findClaim(page);

        if (pos) break;

        console.log('⏳ retry...');
        await delay(3000);
    }

    if (!pos) {
        return { success: false, message: 'CLAIM introuvable' };
    }

    console.log('📍 trouvé:', pos);

    let success = false;

    const listener = async res => {
        const url = res.url().toLowerCase();
        if (url.includes('claim')) {
            const txt = await res.text().catch(() => '');
            if (txt.includes('success')) success = true;
        }
    };

    page.on('response', listener);

    await safeClick(page, pos);

    await delay(10000);

    page.off('response', listener);

    const text = await page.evaluate(() => document.body.innerText.toLowerCase());

    if (success || text.includes('claimed')) {
        return { success: true, message: 'SUCCESS' };
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

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false
            });
        });

        await login(page);

        const result = await claim(page);

        console.log('🏁 RESULT:', result);

    } catch (e) {
        console.log('❌ ERREUR:', e.message);
    } finally {
        if (browser) await browser.close();
    }
})();
