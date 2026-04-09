await page.goto('https://www.cloudflare.com/cdn-cgi/trace');
const text = await page.evaluate(() => document.body.innerText);
console.log(text);
