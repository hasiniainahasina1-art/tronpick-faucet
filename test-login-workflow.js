const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------- Variables d'environnement ----------
const email = process.env.TEST_EMAIL;
const password = process.env.TEST_PASSWORD;
const platform = process.env.TEST_PLATFORM;
const proxyIndex = process.env.TEST_PROXY_INDEX !== '' ? parseInt(process.env.TEST_PROXY_INDEX) : 0;
const initialTimerStr = process.env.TEST_INITIAL_TIMER || '60:00';
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const USER_ID = process.env.USER_ID;

// Fichier individuel par compte
const USER_FILE = USER_ID
    ? `account_${USER_ID}_${platform}_${email}.json`
    : `account_${email}_${platform}.json`;

const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');
if (JP_PROXY_LIST.length === 0) {
    console.error('❌ JP_PROXY_LIST doit contenir au moins 1 proxy');
    process.exit(1);
}

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1) + min));

function parseProxyUrl(proxyUrl) {
    if (!proxyUrl) return null;
    proxyUrl = proxyUrl.trim();
    const isSocks = proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks://');
    const protocol = isSocks ? 'socks5' : 'http';
    const match = proxyUrl.match(/^(socks5?:\/\/)?(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
    if (!match) { console.error('❌ Format HTTP invalide'); return null; }
    return {
        server: `${protocol}://${match[4]}:${match[5]}`,
        username: match[2] || null,
        password: match[3] || null
    };
}

function timeStrToMinutes(str) {
    if (!str || !str.includes(':')) return 60;
    const parts = str.split(':');
    const mins = parseInt(parts[0]) || 0;
    const secs = parseInt(parts[1]) || 0;
    return mins + secs / 60;
}

// --- Remplissage humain des champs ---
async function fillFieldHuman(page, selector, value, fieldName) {
    console.log(`⌨️ Remplissage humain de ${fieldName}...`);
    await page.waitForSelector(selector, { visible: true, timeout: 10000 });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await randomDelay(100, 200);
    for (const char of value) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 70) + 30 });
    }
    await randomDelay(200, 500);
    let actual = await page.$eval(selector, el => el.value);
    if (actual !== value) {
        console.warn(`⚠️ Correction du champ ${fieldName}, nouvelle tentative`);
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        for (const char of value) await page.keyboard.type(char, { delay: Math.floor(Math.random() * 50) + 40 });
    }
}

// --- Point rouge ---
async function addRedDot(page, x, y) {
    await page.evaluate((x, y) => {
        const dot = document.createElement('div');
        dot.style.position = 'fixed';
        dot.style.left = (x - 5) + 'px';
        dot.style.top = (y - 5) + 'px';
        dot.style.width = '10px';
        dot.style.height = '10px';
        dot.style.borderRadius = '50%';
        dot.style.backgroundColor = 'red';
        dot.style.zIndex = '99999';
        dot.style.pointerEvents = 'none';
        dot.id = 'click-dot';
        document.body.appendChild(dot);
        setTimeout(() => dot.remove(), 5000);
    }, x, y);
}

// --- Clic humain ---
async function humanClickAt(page, coords) {
    await addRedDot(page, coords.x, coords.y);
    await randomDelay(150, 300);
    const start = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const cp = { x: start.x + (Math.random() - 0.5) * 100, y: start.y + (Math.random() - 0.5) * 100 };
        const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * cp.x + Math.pow(t, 2) * coords.x;
        const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * cp.y + Math.pow(t, 2) * coords.y;
        await page.mouse.move(x, y);
        await delay(15);
    }
    await page.mouse.click(coords.x, coords.y);
    console.log(`🖱️ Clic à (${coords.x}, ${coords.y})`);
}

// --- Connexion proxy ---
async function connectWithProxy(proxyUrl) {
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) throw new Error('Proxy invalide');
    console.log(`🔄 Connexion avec proxy : ${proxyConfig.server}`);
    const options = {
        headless: false,
        turnstile: true,
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    const { browser, page } = await connect(options);
    return { browser, page };
}

// --- Sauvegarde GitHub ---
async function saveAccount(accountData) {
    const octokit = new Octokit({ auth: GH_TOKEN });
    let sha = null;
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME, repo: GH_REPO, path: USER_FILE, ref: GH_BRANCH
        });
        sha = res.data.sha;
    } catch (e) {}
    const content = Buffer.from(JSON.stringify(accountData, null, 2)).toString('base64');
    await octokit.repos.createOrUpdateFileContents({
        owner: GH_USERNAME,
        repo: GH_REPO,
        path: USER_FILE,
        message: `Ajout du compte ${email}`,
        content,
        branch: GH_BRANCH,
        sha
    });
}

// --- FFmpeg ---
function startFFmpeg(videoPath) {
    const display = process.env.DISPLAY || ':99';
    const args = [
        '-f', 'x11grab',
        '-video_size', '1280x720',
        '-i', display,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '0',
        '-pix_fmt', 'yuv420p',
        '-y',
        videoPath
    ];
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'inherit' });
    console.log(`🎥 FFmpeg démarré sur ${display}, vidéo → ${videoPath}`);
    return ffmpeg;
}
function stopFFmpeg(ffmpeg) {
    return new Promise((resolve) => {
        ffmpeg.on('close', resolve);
        ffmpeg.kill('SIGINT');
    });
}

// --- Fonction pour cliquer sur un texte dans la page ou les iframes (sans XPath) ---
async function clickOnText(page, text) {
    // Cherche dans le document principal d'abord
    const clickedInMain = await page.evaluate((searchText) => {
        const elements = document.querySelectorAll('*');
        for (const el of elements) {
            if (el.textContent?.trim() === searchText) {
                el.click();
                return true;
            }
        }
        return false;
    }, text);

    if (clickedInMain) {
        console.log(`✅ Texte "${text}" trouvé et cliqué dans le DOM principal`);
        return true;
    }

    // Cherche dans toutes les iframes
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const clickedInFrame = await frame.evaluate((searchText) => {
                const elements = document.querySelectorAll('*');
                for (const el of elements) {
                    if (el.textContent?.trim() === searchText) {
                        el.click();
                        return true;
                    }
                }
                return false;
            }, text);
            if (clickedInFrame) {
                console.log(`✅ Texte "${text}" trouvé et cliqué dans une iframe (url: ${frame.url()})`);
                return true;
            }
        } catch (e) {
            // Ignorer les iframes cross-origin inaccessibles
        }
    }

    console.warn(`⚠️ Texte "${text}" introuvable`);
    return false;
}

// --- NOUVELLE SÉQUENCE DE LOGIN HUMAINE ---
async function performLoginWithCaptcha(page, email, password) {
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
    const videoPath = path.join(screenshotsDir, `login_${email.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`);
    const ffmpegProcess = startFFmpeg(videoPath);
    await delay(1000);

    try {
        // 1. Remplissage humain
        await fillFieldHuman(page, 'input[type="email"], input[name="email"]', email, 'email');
        await fillFieldHuman(page, 'input[type="password"]', password, 'password');
        await randomDelay(500, 1000);

        // 2. Scroll jusqu’au bouton "Log in"
        console.log('📜 Scroll jusqu’au bouton Log in...');
        await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const loginBtn = btns.find(b => b.textContent.trim() === 'Log in');
            if (loginBtn) loginBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        await delay(3000);

        // 3. Sélection de Cloudflare Turnstile
        console.log('🔍 Sélection du type de captcha...');
        const selectSelector = 'select';
        await page.waitForSelector(selectSelector, { visible: true, timeout: 10000 });
        const availableOptions = await page.$$eval(`${selectSelector} option`, opts =>
            opts.map(o => ({ text: o.textContent.trim(), value: o.value }))
        );
        console.log('📋 Options disponibles :', availableOptions);

        const targetOptionText = 'Cloudflare Turnstile';
        const target = availableOptions.find(o => o.text === targetOptionText);
        if (!target) throw new Error(`Option "${targetOptionText}" introuvable`);
        await page.select(selectSelector, target.value);
        console.log(`✅ Option "${targetOptionText}" sélectionnée`);
        await page.screenshot({ path: path.join(screenshotsDir, '01_option_selected.png'), fullPage: true });
        await delay(5000);

        // 4. Clic sur "Verify you are human"
        console.log('🕵️ Recherche du texte "Verify you are human"...');
        const verifyText = 'Verify you are human';
        const clicked = await clickOnText(page, verifyText);
        await page.screenshot({ path: path.join(screenshotsDir, '02_verify_clicked.png'), fullPage: true });
        await delay(10000);

        // 5. Clic sur le bouton "Log in"
        console.log('📍 Clic sur le bouton Log in...');
        let loginCoords = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const loginBtn = btns.find(b => b.textContent.trim() === 'Log in');
            if (!loginBtn) return null;
            const rect = loginBtn.getBoundingClientRect();
            return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        });
        if (!loginCoords) {
            console.warn('⚠️ Bouton Log in non trouvé, fallback (640,615)');
            loginCoords = { x: 640, y: 615 };
        }
        await humanClickAt(page, loginCoords);
        await randomDelay(2000, 3000);

        // Vérification de la connexion
        try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 });
        } catch (navError) {
            console.warn('⚠️ Navigation non détectée, vérification manuelle...');
            await delay(5000);
            if (page.url().includes('login.php')) {
                const errorMsg = await page.evaluate(() => {
                    const el = document.querySelector('.alert-danger, .error');
                    return el ? el.textContent.trim() : null;
                });
                throw new Error(errorMsg || 'Échec connexion');
            }
        }
        if (page.url().includes('login.php')) {
            const errorMsg = await page.evaluate(() => {
                const el = document.querySelector('.alert-danger, .error');
                return el ? el.textContent.trim() : null;
            });
            throw new Error(errorMsg || 'Échec connexion');
        }

        console.log('✅ Connexion réussie');
    } finally {
        await stopFFmpeg(ffmpegProcess);
        console.log('🎥 Vidéo sauvegardée.');
    }
}

// --- Main ---
async function run() {
    let browser;
    try {
        const proxyUrl = JP_PROXY_LIST[proxyIndex] || JP_PROXY_LIST[0];
        if (!proxyUrl) throw new Error('Proxy indisponible');
        console.log(`🔄 Proxy utilisé : ${proxyUrl}`);

        const { browser: br, page } = await connectWithProxy(proxyUrl);
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });

        const loginUrl = `https://${platform}.io/login.php`;
        console.log(`🌐 Connexion à ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.screenshot({ path: path.join(screenshotsDir, '00_login_page.png'), fullPage: true });

        await performLoginWithCaptcha(page, email, password);
        console.log('✅ Login réussi');

        const cookies = await page.cookies();
        console.log(`🍪 Cookies récupérés : ${cookies.length}`);

        await page.screenshot({ path: path.join(screenshotsDir, '99_login_success.png'), fullPage: true });
        await browser.close();

        const timerValue = timeStrToMinutes(initialTimerStr);
        const normalizedEmail = email.trim().toLowerCase();
        const account = {
            email: normalizedEmail,
            password,
            platform,
            proxyIndex,
            enabled: true,
            cookies,
            cookiesStatus: 'valid',
            lastClaim: Date.now(),
            timer: timerValue
        };

        await saveAccount(account);
        console.log(`✅ Compte ${normalizedEmail} enregistré avec succès (timer = ${initialTimerStr})`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        if (browser) {
            try {
                const ss = await browser.screenshot({ fullPage: true });
                fs.writeFileSync(path.join(screenshotsDir, 'error.png'), ss);
            } catch (e) {}
            await browser.close();
        }
        process.exit(1);
    }
}
run();
