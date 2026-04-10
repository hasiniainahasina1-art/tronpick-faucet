const { connect } = require('puppeteer-real-browser');

const EMAIL = process.env.TRONPICK_EMAIL?.trim().toLowerCase();
const PASSWORD = process.env.TRONPICK_PASSWORD;

const PROXY_HOST = '31.59.20.176';
const PROXY_PORT = '6754';
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;

const delay = ms => new Promise(r => setTimeout(r, ms));

/* ================= SAFE NAV ================= */
async function safeGoto(page, url) {
    console.log('🌐 Navigation:', url);

    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    }).catch(() => console.log('⚠️ timeout ignoré'));

    await delay(5000);
}

/* ================= HUMAN ================= */
async function human(page) {
    for (let i = 0; i < 4; i++) {
        await page.mouse.move(
            Math.random() * 900,
            Math.random() * 700,
            { steps: 20 }
        );
        await delay(300);
    }
}

/* ================= LOGIN ROBUSTE ================= */
async function login(page) {
    await safeGoto(page, 'https://tronpick.io/login.php');

    console.log('⏳ Attente page login...');

    await page.waitForFunction(() => document.body.innerText.length > 50, {
        timeout: 60000
    }).catch(() => {});

    await delay(4000);

    const emailSelectors = [
        'input[type="email"]',
        'input[name="email"]',
        'input[type="text"]',
        'input'
    ];

    const passSelectors = [
        'input[type="password"]',
        'input[name="password"]'
    ];

    let emailSel = null;
    let passSel = null;

    for (let i = 0; i < 10; i++) {
        for (const s of emailSelectors) {
            if (await page.$(s)) {
                emailSel = s;
                break;
            }
        }

        for (const s of passSelectors) {
            if (await page.$(s)) {
                passSel = s;
                break;
            }
        }

        if (emailSel && passSel) break;

        console.log('⏳ recherche inputs...');
        await delay(2000);
    }

    if (!emailSel || !passSel) {
        throw new Error('❌ Inputs login introuvables');
    }

    console.log('⌨️ remplissage...');

    await page.click(emailSel);
    await page.keyboard.type(EMAIL, { delay: 70 });

    await delay(500);

    await page.click(passSel);
    await page.keyboard.type(PASSWORD, { delay: 70 });

    await human(page);

    const loginBtn = await page.evaluateHandle(() => {
        return [...document.querySelectorAll('button, input')]
            .find(b => (b.textContent || b.value || '').toLowerCase().includes('log'));
    });

    if (!loginBtn) throw new Error('❌ bouton login introuvable');

    await loginBtn.click().catch(() => console.log('⚠️ fallback click'));

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

/* ================= FIND BUTTON ================= */
async function findButton(page) {
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
        await page.mouse.move(pos.x, pos.y, { steps: 25 });
        await delay(300);

        await page.mouse.click(pos.x, pos.y, {
            delay: 100
        });

        console.log('🔥 CLICK:', pos.text);

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

    await delay(6000);

    await debugButtons(page);

    console.log('🔍 recherche CLAIM...');

    let pos = null;

    for (let i = 0; i < 6; i++) {
        pos = await findButton(page);

        if (pos) break;

        console.log('⏳ retry...');
        await delay(3000);
    }

    if (!pos) {
        return { success: false, message: 'CLAIM introuvable' };
    }

    console.log('📍 trouvé:', pos);

    let success = false;

    page.on('response', async res => {
        if (res.url().includes('claim')) {
            const txt = await res.text().catch(() => '');
            if (txt.includes('success')) success = true;
        }
    });

    await safeClick(page, pos);

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

    return { success: false, message: 'FAIL' };
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
        console.log('❌ ERROR:', e.message);
    } finally {
        if (browser) await browser.close();
    }
})();
