const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

// Coordonnées
const STEP1_COORDS = { x: 700, y: 550 };
const STEP2_COORDS = { x: 700, y: 800 };
const STEP3_COORDS = { x: 651, y: 450 };
const STEP4_COORDS = { x: 651, y: 682 };

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// --- Fonctions Puppeteer ---
async function fillField(page, selector, value, fieldName) {
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await delay(100);
    await page.evaluate((sel, val) => { const el = document.querySelector(sel); if (el) el.value = val; }, selector, value);
    await delay(300);
    let actual = await page.$eval(selector, el => el.value);
    if (actual !== value) {
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        for (const char of value) await page.keyboard.type(char, { delay: 30 });
    }
}

async function addRedDot(page, x, y) {
    await page.evaluate((x, y) => {
        const dot = document.createElement('div');
        dot.style.position = 'fixed'; dot.style.left = (x - 5) + 'px'; dot.style.top = (y - 5) + 'px';
        dot.style.width = '10px'; dot.style.height = '10px'; dot.style.borderRadius = '50%';
        dot.style.backgroundColor = 'red'; dot.style.zIndex = '99999'; dot.style.pointerEvents = 'none';
        dot.id = 'click-dot'; document.body.appendChild(dot);
        setTimeout(() => dot.remove(), 5000);
    }, x, y);
}

async function humanClickAt(page, coords) {
    await addRedDot(page, coords.x, coords.y);
    await delay(200);
    const start = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const cp = { x: start.x + (Math.random() - 0.5) * 100, y: start.y + (Math.random() - 0.5) * 100 };
        const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * cp.x + Math.pow(t, 2) * coords.x;
        const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * cp.y + Math.pow(t, 2) * coords.y;
        await page.mouse.move(x, y); await delay(15);
    }
    await page.mouse.click(coords.x, coords.y);
    console.log(`🖱️ Clic à (${coords.x}, ${coords.y})`);
}

// --- Connexion proxy (version stable) ---
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

// --- Sauvegarde du compte ---
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

// --- 🎥 Capture vidéo ffmpeg (qualité maximale) ---
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

// --- Nouvelle séquence CAPTCHA (scroll + double‑clic + vidéo) ---
async function performLoginWithCaptcha(page, email, password) {
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
    const videoPath = path.join(screenshotsDir, `login_${email.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`);
    const ffmpegProcess = startFFmpeg(videoPath);
    await delay(1000);

    try {
        await fillField(page, 'input[type="email"], input[name="email"]', email, 'email');
        await fillField(page, 'input[type="password"]', password, 'password');
        await delay(2000);

        // --- Scroll pour amener l'icône dans la vue (simuler un humain) ---
        console.log('📜 Scroll vers le captcha...');
        await page.evaluate(() => window.scrollBy(0, 400));
        await delay(1000);

        // --- 1er clic : double‑clic sur l'icône captcha (700,550) ---
        console.log('🖱️ Premier clic sur l\'icône captcha (700,550)');
        await humanClickAt(page, STEP1_COORDS);
        await delay(2000);   // attente 2s
        console.log('🖱️ Second clic sur l\'icône captcha (700,550)');
        await humanClickAt(page, STEP1_COORDS);
        await page.screenshot({ path: path.join(screenshotsDir, '01_doubleclick_icon.png'), fullPage: true });
        await delay(5000);   // attente 5s après le double‑clic

        // --- 2e clic (700,800) ---
        console.log('🖱️ Étape 2 : clic (700,800)');
        await humanClickAt(page, STEP2_COORDS);
        await page.screenshot({ path: path.join(screenshotsDir, '02_step2.png'), fullPage: true });
        await delay(7000);

        // --- 3e clic (651,450) ---
        console.log('🖱️ Étape 3 : clic (651,450)');
        await humanClickAt(page, STEP3_COORDS);
        await page.screenshot({ path: path.join(screenshotsDir, '03_step3.png'), fullPage: true });
        await delay(15000);

        // --- 4e clic (651,682) ---
        console.log('🖱️ Étape 4 : clic (651,682)');
        await humanClickAt(page, STEP4_COORDS);
        await page.screenshot({ path: path.join(screenshotsDir, '04_step4.png'), fullPage: true });
        await delay(10000);

        // Attendre la navigation
        try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 });
        } catch (navError) {
            console.warn('⚠️ Navigation après login non détectée, vérification manuelle...');
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
    } finally {
        await stopFFmpeg(ffmpegProcess);
        console.log('🎥 Vidéo sauvegardée.');
    }
}

// --- Main (inchangé) ---
async function run() { /* ... identique ... */ }
run();
