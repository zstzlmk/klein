#!/usr/bin/env node
/**
 * Kleinanzeigen Category & Attribute Scraper
 *
 * 1. Connects to Chrome, opens category selection page to extract the full
 *    category tree from inline JS.
 * 2. For each leaf category, POSTs to the form page and extracts attribute schemas
 *    from the server-rendered Astro component props.
 * 3. Saves categories.json with tree, flat list, and attributeSchemas.
 *
 * Usage: node scrape-categories.js
 * (Chrome must be running with --remote-debugging-port=9222 and logged into Kleinanzeigen)
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUTPUT = path.join(__dirname, '..', 'categories.json');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function connectToBrowser() {
    const r = await fetch('http://127.0.0.1:9222/json/version');
    const d = await r.json();
    return puppeteer.connect({ browserWSEndpoint: d.webSocketDebuggerUrl, defaultViewport: null });
}

async function main() {
    console.log('Connecting to Chrome...');
    const browser = await connectToBrowser();

    try {
        // Step 1: Extract the category tree from the category selection page
        console.log('Opening category selection page...');
        const page = await browser.newPage();
        await page.goto('https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html', {
            waitUntil: 'networkidle2', timeout: 30000
        });

        // The page might redirect to the category selection page or show the form.
        // If it shows the form, click "Kategorie ändern" to get to category selection.
        await wait(2000);

        // Check if we're on the form page (has #ad-title) or category page
        const onForm = await page.$('#ad-title');
        if (onForm) {
            console.log('On form page, navigating to category selection...');
            const clicked = await page.evaluate(() => {
                for (const a of document.querySelectorAll('a')) {
                    if (a.textContent.includes('Kategorie ändern') || a.textContent.includes('Wähle deine Kategorie')) {
                        a.click(); return true;
                    }
                }
                return false;
            });
            if (clicked) {
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
                await wait(2000);
            }
        }

        // Now extract the category tree from the inline script
        console.log('Extracting category tree...');
        const categoryTree = await page.evaluate(() => {
            // The tree is passed to Belen.PostAd.CategorySelectView.init({ categoryTree: ... })
            // It's embedded in a <script> tag as a JS object literal
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const text = script.textContent;
                if (text.includes('CategorySelectView.init')) {
                    // Extract the categoryTree object using regex
                    const match = text.match(/categoryTree\s*:\s*(\{[\s\S]*?\})\s*,\s*allowedCategories/);
                    if (match) {
                        try {
                            return eval('(' + match[1] + ')');
                        } catch (e) {
                            // Try a different approach - find the JSON-like structure
                            return null;
                        }
                    }
                }
            }
            return null;
        });

        if (!categoryTree) {
            console.error('Could not extract category tree from page.');
            console.log('Trying alternative extraction...');

            // Alternative: extract from the page's JS context
            const altTree = await page.evaluate(() => {
                // Look for the tree in window or global scope
                if (window.categoryTree) return window.categoryTree;
                // Try to find it in script content with a more lenient regex
                for (const s of document.querySelectorAll('script')) {
                    const t = s.textContent;
                    const idx = t.indexOf('"identifier" : "0"');
                    if (idx !== -1) {
                        // Find the opening { before this
                        let start = t.lastIndexOf('{', idx);
                        // Find the matching closing }
                        let depth = 0;
                        for (let i = start; i < t.length; i++) {
                            if (t[i] === '{') depth++;
                            if (t[i] === '}') depth--;
                            if (depth === 0) {
                                try {
                                    return JSON.parse(t.substring(start, i + 1));
                                } catch (e) {
                                    // The tree uses JS object notation, not strict JSON
                                    // Try eval
                                    try {
                                        return eval('(' + t.substring(start, i + 1) + ')');
                                    } catch (e2) {}
                                }
                                break;
                            }
                        }
                    }
                }
                return null;
            });

            if (!altTree) {
                console.error('Failed to extract category tree. Make sure you are logged in.');
                await page.close();
                await browser.disconnect();
                process.exit(1);
            }

            console.log('Category tree extracted via alternative method.');
            await buildOutput(browser, page, altTree);
        } else {
            console.log('Category tree extracted.');
            await buildOutput(browser, page, categoryTree);
        }

    } catch (e) {
        console.error('Error:', e);
    } finally {
        await browser.disconnect();
    }
}

async function buildOutput(browser, page, tree) {
    // Step 2: Build flat list of leaf categories (those with fieldName === "categoryId")
    const flat = [];
    const parentMap = {};

    function walk(node, parentName) {
        if (!node.children) return;
        for (const child of node.children) {
            if (child.fieldName === 'categoryId') {
                flat.push({
                    id: child.fieldValue,
                    name: child.name,
                    parentName: parentName,
                    path: parentName + ' > ' + child.name,
                    hasArt: !!(child.children && child.children.length > 0),
                    artOptions: child.children ? child.children.map(a => ({
                        value: a.fieldValue,
                        name: a.name,
                        fieldName: a.fieldName
                    })) : []
                });
            } else if (child.fieldName === 'parentCategoryId') {
                parentMap[child.name] = child.fieldValue;
                walk(child, child.name);
            }
        }
    }
    walk(tree, '');

    console.log(`Found ${flat.length} leaf categories across ${Object.keys(parentMap).length} parent categories.`);

    // Step 3: For each leaf category, get the attribute schema by loading the form
    // We'll use the existing page and POST to the form with each categoryId
    console.log('Fetching attribute schemas...');

    // Get cookies and CSRF token from the page
    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');

    // Get CSRF token
    const csrf = await page.evaluate(() => {
        const inp = document.querySelector('input[name="_csrf"]');
        if (inp) return inp.value;
        // Try from textarea
        for (const ta of document.querySelectorAll('textarea[name="_csrf"]')) return ta.value;
        // Try from meta or script
        const match = document.documentElement.innerHTML.match(/csrfToken['":\s]+['"]([^'"]+)['"]/);
        return match ? match[1] : '';
    });

    console.log(`CSRF token: ${csrf ? csrf.substring(0, 10) + '...' : 'NOT FOUND'}`);

    const attributeSchemas = {};
    let done = 0;

    // Process in batches
    const BATCH = 5;
    for (let i = 0; i < flat.length; i += BATCH) {
        const batch = flat.slice(i, i + BATCH);
        await Promise.all(batch.map(async (cat) => {
            try {
                // POST to the form page with this categoryId
                const formData = new URLSearchParams();
                formData.append('categoryId', cat.id);
                formData.append('_csrf', csrf);
                formData.append('adType', 'OFFER');
                formData.append('priceType', 'FIXED');
                formData.append('zipCode', '44141');
                formData.append('locationId', '16814');

                const resp = await fetch('https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Cookie': cookieStr,
                    },
                    body: formData.toString(),
                    redirect: 'follow',
                });

                const html = await resp.text();

                // Extract the PostListingForm props from the Astro island
                // The attributes are in the "category" > "attributes" section of the props
                const attrMatch = html.match(/&quot;attributes&quot;:\[0,\{([\s\S]*?)\}\],&quot;shippable/);
                if (attrMatch) {
                    // Parse the Astro-encoded attributes
                    const attrsRaw = '{' + attrMatch[1] + '}';
                    // Decode HTML entities
                    const decoded = attrsRaw.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

                    // Parse the Astro format: "key":[0,{...}]
                    const attrs = {};
                    const attrRegex = /"([^"]+)":\[0,\{([^}]*"attributeId"[^}]*)\}/g;
                    let m;
                    while ((m = attrRegex.exec(decoded)) !== null) {
                        const attrKey = m[1];
                        const attrBody = '{' + m[2] + '}';

                        // Extract fields from the attribute body
                        const getName = (s, k) => { const r = s.match(new RegExp(`"${k}":\\[0,"([^"]*)"\\]`)); return r ? r[1] : ''; };
                        const getBool = (s, k) => { const r = s.match(new RegExp(`"${k}":\\[0,(true|false)\\]`)); return r ? r[1] === 'true' : false; };

                        const name = getName(attrBody, 'localizedName');
                        const required = getBool(attrBody, 'required');
                        const render = getName(attrBody, 'render');
                        const fakeSubCategory = getBool(attrBody, 'fakeSubCategory');

                        // Extract options
                        const options = [];
                        const optRegex = /\{[^}]*"value":\[0,"([^"]*)"\][^}]*"localizedValue":\[0,"([^"]*)"\][^}]*\}/g;
                        // Need to find the localizedOptions array for this attribute
                        const optSection = decoded.substring(decoded.indexOf(attrKey));
                        const optArrayMatch = optSection.match(/"localizedOptions":\[1,\[([\s\S]*?)\]\]/);
                        if (optArrayMatch) {
                            let om;
                            const optStr = optArrayMatch[1];
                            while ((om = optRegex.exec(optStr)) !== null) {
                                options.push({ value: om[1], label: om[2].replace(/&amp;/g, '&') });
                            }
                        }

                        attrs[attrKey] = { name, required, render, fakeSubCategory, options };
                    }

                    attributeSchemas[cat.id] = { categoryName: cat.name, parentName: cat.parentName, attributes: attrs };
                }
            } catch (e) {
                console.warn(`  Failed to fetch schema for ${cat.name} (${cat.id}): ${e.message}`);
            }

            done++;
            if (done % 10 === 0 || done === flat.length) {
                process.stdout.write(`\r  ${done}/${flat.length} categories processed`);
            }
        }));
    }

    console.log('\n');

    // Step 4: Save output
    const output = {
        version: new Date().toISOString(),
        tree: tree,
        categories: flat,
        parentCategories: Object.entries(parentMap).map(([name, id]) => ({ name, id })),
        attributeSchemas: attributeSchemas,
    };

    fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
    console.log(`Saved ${OUTPUT}`);
    console.log(`  ${flat.length} categories, ${Object.keys(attributeSchemas).length} schemas`);

    await page.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
