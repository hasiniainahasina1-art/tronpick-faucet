const puppeteer = require('puppeteer-core');

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

const delay = (min, max) =>
    new Promise(res => setTimeout(res, Math.random() * (max - min) + min));

async function moveMouseHuman(page, x, y) {
    const steps = 10 + Math.floor(Math.random() * 10);

    for (let i = 0; i < steps; i++) {
        await page.mouse.move(
            x + (Math.random() * 5),
            y + (Math.random() * 5)
        );
        await delay(10, 40);
    }
}

// 🔍 Vérifie si captcha validé
async function isTurnstileSolved(page) {
    return await page.evaluate(() => {
        const el = document.querySelector('[name="cf-turnstile-response"]');
        return el && el.value && el.value.length > 0;
    });
}

// 🎯 Clique réel dans iframe
async function clickTurnstile(page) {
    const frame = page.frames().find(f =>
        f.url().includes("challenges.cloudflare.com")
    );

    if (!frame) throw new Error("Turnstile iframe introuvable");

    const checkbox = await frame.waitForSelector('input[type="checkbox"]', {
        timeout: 8000
    });

    const box = await checkbox.boundingBox();
    if (!box) throw new Error("Position checkbox introuvable");

    await moveMouseHuman(page, box.x + box.width / 2, box.y + box.height / 2);
    await delay(500, 1200);

    await page.mouse.click(
        box.x + box.width / 2,
        box.y + box.height / 2
    );
}

export default async function handler(req, res) {
    let browser;
    const screenshots = [];

    try {
        console.log("🚀 START");

        browser = await puppeteer.connect({
            browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`
        });

        const page = await browser.newPage();

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
        );

        await page.setViewport({ width: 1280, height: 720 });

        await page.goto('https://tronpick.io/login.php', {
            waitUntil: 'domcontentloaded'
        });

        screenshots.push({
            label: "01_loaded",
            base64: await page.screenshot({ encoding: 'base64', fullPage: true })
        });

        let solved = false;

        for (let i = 1; i <= 5; i++) {
            console.log(`🔁 Tentative ${i}`);

            await delay(3000, 6000);

            try {
                await clickTurnstile(page);
            } catch (e) {
                console.log("⚠️ clic impossible:", e.message);
            }

            await delay(4000, 7000);

            // 📸 capture après tentative
            screenshots.push({
                label: `0${i}_after_click`,
                base64: await page.screenshot({ encoding: 'base64', fullPage: true })
            });

            // ✅ vérification
            solved = await isTurnstileSolved(page);

            console.log("🎯 Solved:", solved);

            if (solved) {
                screenshots.push({
                    label: "SUCCESS",
                    base64: await page.screenshot({ encoding: 'base64', fullPage: true })
                });
                break;
            }
        }

        await browser.close();

        res.status(200).json({
            success: solved,
            message: solved ? "Captcha validé" : "Échec après plusieurs tentatives",
            screenshots
        });

    } catch (error) {
        console.error("❌ ERROR:", error);

        if (browser) await browser.close().catch(() => {});

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
}
