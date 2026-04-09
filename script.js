const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// --- Helper for user input in console ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

// --- CONFIGURATION ---
const CONFIG_FILE_PATH = path.join(__dirname, 'config.json');

// Step 1: OLD category selection page selectors
const STEP1_SELECTORS = {
    headline: '#postad-step1-headline',
    categorySelectBox: '#postad-category-select-box',
    categoryLink: '.category-selection-list-item-link',
    form: '#postad-step1-frm',
    submitButton: '#postad-step1-sbmt button[type="submit"]',
};

// Step 2: NEW Astro/React ad form selectors
const SELECTORS = {
    title: '#ad-title',
    description: '#ad-description',
    price: '#ad-price-amount',
    priceType: '#ad-price-type',
    zipCode: '#ad-zip-code',
    city: '#ad-city',
    street: '#ad-street',
    addressVisibility: '#ad-address-visibility',
    name: '#ad-name',
    photoUploadInput: 'input[type="file"][accept*="image"]',
};

// --- Connect to existing Chrome instance ---
async function connectToBrowser() {
    try {
        const response = await fetch('http://127.0.0.1:9222/json/version');
        const data = await response.json();
        const browserWSEndpoint = data.webSocketDebuggerUrl;
        console.log('Connecting to existing Chrome instance...');
        const browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null });
        return browser;
    } catch (e) {
        console.error('\n--- ERROR ---');
        console.error('Could not connect to Chrome on port 9222.');
        console.error('Please ensure you have launched Chrome with the remote debugging flag.');
        console.error('See the README.md file for instructions.');
        console.error('-------------');
        return null;
    }
}

// --- ONE-TIME SETUP: Get and save the main project folder path ---
async function getProjectFolderPath() {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf-8'));
            if (config.projectFolder && fs.existsSync(config.projectFolder)) {
                console.log(`Using project folder from config: ${config.projectFolder}`);
                return config.projectFolder;
            }
        } catch (error) {
            console.log('Could not read config.json, will ask for path again.');
        }
    }

    const folderPath = await askQuestion('--> SETUP: Please drag your main project folder (e.g., "kleinanzeigen") here and press Enter: ');
    const cleanedPath = folderPath.trim().replace(/\\ /g, ' ').replace(/'/g, '');

    if (!fs.existsSync(cleanedPath) || !fs.lstatSync(cleanedPath).isDirectory()) {
        console.error('Error: The provided path is not a valid directory. Please restart the script.');
        process.exit(1);
    }

    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify({ projectFolder: cleanedPath }, null, 4));
    console.log(`Path saved to config.json for future use.`);
    return cleanedPath;
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Find the Kleinanzeigen page and detect which step we're on ---
// Returns { page, step } where step is 'step1' (category) or 'step2' (form)
// Detection is purely DOM-based — no hardcoded URLs.
async function findAdPage(browser) {
    const pages = await browser.pages();

    for (const p of pages) {
        if (!p.url().includes('kleinanzeigen.de')) continue;

        // Step 2: new React ad form (has #ad-title)
        try {
            await p.waitForSelector(SELECTORS.title, { visible: true, timeout: 1500 });
            return { page: p, step: 'step2' };
        } catch (e) {}

        // Step 1: old category selection page (has JS-rendered .category-selection-list-item-link)
        try {
            await p.waitForSelector('.category-selection-list-item-link', { visible: true, timeout: 3000 });
            return { page: p, step: 'step1' };
        } catch (e) {}

        // Step 1 fallback: category box exists but links not rendered yet
        try {
            await p.waitForSelector(STEP1_SELECTORS.categorySelectBox, { timeout: 1500 });
            return { page: p, step: 'step1' };
        } catch (e) {}
    }

    return null;
}

// --- CATEGORY SELECTION on Step 1 (old page) ---
async function selectCategoryStep1(page, adData) {
    console.log('  On category selection page (Step 1)...');

    // Helper: wait for new category links to appear after clicking a parent.
    // Each click causes JS to re-render the list. We detect this by waiting
    // for a link whose text we haven't seen before, or a short timeout.
    const waitForCategoryUpdate = async (previousTexts) => {
        for (let i = 0; i < 20; i++) { // up to 4 seconds
            await wait(200);
            const currentTexts = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.category-selection-list-item-link'))
                    .map(el => el.textContent.trim());
            });
            // If the list changed (new items appeared), we're good
            if (currentTexts.length > 0 && JSON.stringify(currentTexts) !== JSON.stringify(previousTexts)) {
                return currentTexts;
            }
        }
        return null;
    };

    // Click through the categoryPath levels (e.g. "Mode & Beauty > Herrenbekleidung")
    if (adData.categoryPath) {
        const parts = adData.categoryPath.split('>').map(s => s.trim());
        console.log(`  Category path: ${parts.join(' > ')}`);

        for (const part of parts) {
            // Snapshot current links before clicking
            const beforeTexts = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.category-selection-list-item-link'))
                    .map(el => el.textContent.trim());
            });

            const found = await page.evaluate((categoryName) => {
                const links = document.querySelectorAll('.category-selection-list-item-link');
                for (const link of links) {
                    if (link.textContent.trim() === categoryName) {
                        link.click();
                        return true;
                    }
                }
                return false;
            }, part);

            if (found) {
                console.log(`  ... selected: ${part}`);
                // Wait for the subcategory list to update
                await waitForCategoryUpdate(beforeTexts);
            } else {
                console.warn(`  ... could not find category: ${part}`);
            }
        }
    }

    // Handle the "art" sub-selection if present in dynamicFields
    // The page uses links with id like #cat_betten
    if (adData.dynamicFields) {
        for (const [key, value] of Object.entries(adData.dynamicFields)) {
            if (key.includes('.art_s')) {
                await wait(300);
                // Try by id first (#cat_betten), then by matching link text/href
                const clicked = await page.evaluate((artValue) => {
                    // Try by ID
                    const byId = document.getElementById('cat_' + artValue);
                    if (byId) { byId.click(); return true; }
                    // Fallback: search all category links
                    const links = document.querySelectorAll('.category-selection-list-item-link');
                    for (const link of links) {
                        if (link.id && link.id.includes(artValue)) {
                            link.click();
                            return true;
                        }
                    }
                    return false;
                }, value);

                if (clicked) {
                    console.log(`  ... selected art: ${value}`);
                    await wait(500);
                } else {
                    console.warn(`  ... could not find art: ${value}`);
                }
                break; // Only one art field per category
            }
        }
    }

    // Click "Weiter" to submit the form and navigate to Step 2
    await wait(500);
    try {
        await page.waitForSelector(STEP1_SELECTORS.submitButton, { visible: true, timeout: 5000 });
        await page.click(STEP1_SELECTORS.submitButton);
        console.log('  ... clicked Weiter, waiting for form page...');
    } catch (e) {
        console.log('  ... Weiter button not found, form may have auto-submitted.');
    }

    // The form POSTs and navigates to a new page. Wait for navigation to complete
    // then wait for the Step 2 form to load.
    try {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 });
    } catch (e) {
        // Navigation may have already completed
    }
    await page.waitForSelector(SELECTORS.title, { visible: true, timeout: 15000 });
    console.log('  ... category selection complete, now on form page.');
}

// --- CATEGORY SELECTION on Step 2 (new React page, category not yet chosen) ---
// Clicking "Wähle deine Kategorie" navigates to the old category selection page.
// So we detect the navigation and delegate to selectCategoryStep1.
async function selectCategoryStep2(page, adData) {
    console.log('  Selecting category on form page...');

    // Click "Wähle deine Kategorie" or "Kategorie ändern" link
    const clicked = await page.evaluate(() => {
        const links = document.querySelectorAll('a');
        for (const link of links) {
            const text = link.textContent.trim();
            if (text.includes('Wähle deine Kategorie') || text.includes('Kategorie ändern')) {
                link.click();
                return true;
            }
        }
        return false;
    });

    if (!clicked) {
        console.log('  ... Category link not found, may already be selected.');
        return;
    }

    // This click navigates to the old category selection page.
    // Wait for navigation, then wait for the category links to render.
    try {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 });
    } catch (e) {
        // Navigation may have already completed
    }

    // Now we're on the old category page — delegate to selectCategoryStep1
    await page.waitForSelector('.category-selection-list-item-link', { visible: true, timeout: 10000 });
    await selectCategoryStep1(page, adData);
}

// --- Helper: select a value from custom combobox dropdowns (new UI) ---
async function selectComboboxOption(page, buttonSelector, optionText) {
    if (!optionText) return false;
    try {
        await page.waitForSelector(buttonSelector, { visible: true, timeout: 3000 });
        await page.click(buttonSelector);
        await wait(400);

        const clicked = await page.evaluate((text) => {
            const options = document.querySelectorAll('[role="option"], [role="listbox"] li, ul li[role="option"]');
            for (const opt of options) {
                if (opt.textContent.trim() === text) {
                    opt.click();
                    return true;
                }
            }
            return false;
        }, optionText);

        if (!clicked) {
            console.warn(`  ... Could not find combobox option "${optionText}"`);
            await page.keyboard.press('Escape');
        }
        await wait(300);
        return clicked;
    } catch (e) {
        console.warn(`  ... Combobox error: ${e.message}`);
        return false;
    }
}

// --- CAPTURE MODE ---
async function captureData() {
    console.log('\n--- CAPTURE MODE ---');
    const mainFolderPath = await getProjectFolderPath();
    if (!mainFolderPath) { return; }

    const newTemplateName = await askQuestion('--> Enter a name for your new template folder and press Enter: ');

    if (!newTemplateName || newTemplateName.trim() === '') {
        console.error('Error: Template name cannot be empty. Returning to main menu.');
        return;
    }

    const itemFolderPath = path.join(mainFolderPath, newTemplateName.trim());
    if (!fs.existsSync(itemFolderPath)) {
        fs.mkdirSync(itemFolderPath, { recursive: true });
        console.log(`Folder created: "${newTemplateName}"`);
    } else {
        console.log(`Folder "${newTemplateName}" already exists. Data will be saved inside it.`);
    }

    const browser = await connectToBrowser();
    if (!browser) { return; }

    try {
        const result = await findAdPage(browser);
        if (!result) {
            throw new Error('Could not find the Kleinanzeigen page. Please navigate to /p-anzeige-aufgeben-schritt2.html');
        }

        const { page, step } = result;
        await page.bringToFront();

        if (step === 'step1') {
            throw new Error('You are on the category selection page. Please select a category first, then run capture on the form page.');
        }

        console.log('Capturing data from the form...');
        const adData = await page.evaluate(() => {
            const data = {};
            const getVal = (id) => {
                const el = document.getElementById(id);
                return el ? (el.value || '') : '';
            };

            data.title = getVal('ad-title');
            data.description = getVal('ad-description');
            data.price = getVal('ad-price-amount');
            data.zipCode = getVal('ad-zip-code');
            data.street = getVal('ad-street');

            // City name from the combobox display text
            const cityOption = document.getElementById('ad-city-selected-option');
            data.city = cityOption ? cityOption.textContent.trim() : '';

            // Price type from hidden input
            const priceTypeInput = document.querySelector('input[name="priceType"]');
            data.priceType = priceTypeInput ? priceTypeInput.value : 'FIXED';

            // Category ID from hidden input
            const categoryIdInput = document.querySelector('input[name="categoryId"]');
            data.categoryId = categoryIdInput ? categoryIdInput.value : '';

            // Location ID from hidden input
            const locationIdInput = document.querySelector('input[name="locationId"]');
            data.locationId = locationIdInput ? locationIdInput.value : '';

            // Capture dynamic fields
            data.dynamicFields = {};
            data.autocompleteFields = {};

            const excludedNames = [
                'title', 'description', 'priceAmount', 'priceType', 'zipCode',
                'streetName', 'locationId', 'categoryId', 'contactName',
                '_csrf', 'adId', 'trackingId', 'postAdWenkseSessionId',
                'adType', 'addressVisibility', 'marketingOptIn', 'buyNowEligible',
                'adDraftUuid'
            ];

            const form = document.querySelector('form');
            if (form) {
                // Visible inputs
                const inputs = form.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"])');
                inputs.forEach(input => {
                    if (input.name && input.value && !excludedNames.includes(input.name)) {
                        if (input.getAttribute('role') === 'combobox') {
                            data.autocompleteFields[input.id || input.name] = input.value;
                        } else {
                            data.dynamicFields[input.id || input.name] = input.value;
                        }
                    }
                });

                // Selects
                const selects = form.querySelectorAll('select');
                selects.forEach(select => {
                    if (select.name && select.value && !excludedNames.includes(select.name)) {
                        data.dynamicFields[select.id || select.name] = select.value;
                    }
                });

                // Category-specific hidden inputs (attribute maps etc.)
                const hiddenInputs = form.querySelectorAll('input[type="hidden"]');
                hiddenInputs.forEach(input => {
                    if (input.name && input.value && !excludedNames.includes(input.name)) {
                        data.dynamicFields[input.name] = input.value;
                    }
                });
            }

            // Condition
            const conditionRadio = form ? form.querySelector('input[name="condition"]:checked') : null;
            data.condition = conditionRadio ? conditionRadio.value : '';

            // Ad type
            const adTypeRadio = form ? form.querySelector('input[name="adType"]:checked') : null;
            data.adType = adTypeRadio ? adTypeRadio.value : 'OFFER';

            // Shipping options (e.g. ["HERMES_003", "DHL_002"])
            data.shippingOptions = [];
            if (form) {
                const shippingInputs = form.querySelectorAll('input[name^="shippingOptions"][name$=".id"]');
                shippingInputs.forEach(input => {
                    if (input.value) data.shippingOptions.push(input.value);
                });
            }

            return data;
        });

        const outputFilePath = path.join(itemFolderPath, 'data.json');
        fs.writeFileSync(outputFilePath, JSON.stringify(adData, null, 4));
        console.log(`✅ Success! Data captured and saved to: ${outputFilePath}`);
        console.log('--> Reminder: Add your image files to this new folder to complete the template!');

    } catch (error) {
        console.error('An error occurred during capture:', error);
    } finally {
        if (browser) await browser.disconnect();
    }
}

// --- RUN MODE ---
async function runAutomation() {
    console.log('\n--- RUN MODE ---');
    const mainFolderPath = await getProjectFolderPath();
    if (!mainFolderPath) { return; }

    const itemFolders = fs.readdirSync(mainFolderPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory() && !['node_modules', '.git'].includes(dirent.name))
        .map(dirent => dirent.name);

    if (itemFolders.length === 0) {
        console.error(`Error: No item subfolders found in ${mainFolderPath}. Run capture mode first.`);
        return;
    }

    console.log('--> Please choose a template to use:');
    itemFolders.forEach((folder, index) => {
        console.log(`    [${index + 1}] ${folder}`);
    });
    const choiceIndex = await askQuestion('Enter the number of your choice: ');
    const selectedFolderIndex = parseInt(choiceIndex.trim(), 10) - 1;

    if (isNaN(selectedFolderIndex) || selectedFolderIndex < 0 || selectedFolderIndex >= itemFolders.length) {
        console.error('Invalid selection. Returning to main menu.');
        return;
    }

    const selectedTemplate = itemFolders[selectedFolderIndex];

    const browser = await connectToBrowser();
    if (!browser) { return; }

    try {
        const result = await findAdPage(browser);
        if (!result) {
            throw new Error('Could not find the Kleinanzeigen page. Please navigate to /p-anzeige-aufgeben-schritt2.html');
        }

        let { page, step } = result;
        await page.bringToFront();

        const itemFolderPath = path.join(mainFolderPath, selectedTemplate);
        const dataFilePath = path.join(itemFolderPath, 'data.json');
        if (!fs.existsSync(dataFilePath)) {
            throw new Error(`data.json not found in folder: ${selectedTemplate}`);
        }
        const adData = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
        const photoFiles = fs.readdirSync(itemFolderPath)
            .filter(file => ['.jpg', '.jpeg', '.png', '.webp', '.heic'].includes(path.extname(file).toLowerCase()))
            .map(file => path.join(itemFolderPath, file));

        console.log(`Template "${selectedTemplate}" selected. Starting automation...`);

        // --- STEP 1: Handle category selection if we're on the old category page ---
        if (step === 'step1') {
            console.log('On category selection page...');
            if (adData.categoryPath) {
                await selectCategoryStep1(page, adData);
            } else {
                throw new Error('Template has no categoryPath but we are on the category selection page. Please select a category manually first.');
            }
        }

        // --- STEP 2: We should now be on the new React form ---
        // If we started on step2 and category is empty, clicking the category link
        // navigates to step1 and back — selectCategoryStep2 handles the full round-trip.
        if (step === 'step2') {
            const categoryEmpty = await page.evaluate(() => {
                const catInput = document.querySelector('input[name="categoryId"]');
                return !catInput || !catInput.value;
            });

            if (categoryEmpty && adData.categoryPath) {
                await selectCategoryStep2(page, adData);
                // selectCategoryStep2 navigates to step1 and back, page now has the form
            }
        }

        // Ensure form is ready
        await page.waitForSelector(SELECTORS.title, { visible: true, timeout: 15000 });

        // --- Helper: clear and type ---
        const typeInField = async (selector, text) => {
            if (text === undefined || text === null || text === '') return;
            await page.waitForSelector(selector, { visible: true, timeout: 5000 });
            await page.click(selector, { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type(selector, String(text));
        };

        // --- Helper: resolve old template key to new form attribute name ---
        // Old templates: "kleidung_herren.art_s" → new form: "attributeMap[kleidung_herren.art]"
        // Also handles keys already in new format.
        const resolveAttributeName = (key) => {
            // Strip _s suffix (old capture format)
            let clean = key.replace(/_s$/, '');
            return clean;
        };

        // --- Helper: fill a single form attribute by its clean name ---
        // Discovers the element type on the page and interacts accordingly.
        const fillAttribute = async (attrName, value) => {
            const info = await page.evaluate((name) => {
                // Find the hidden input that stores this attribute's value
                const hidden = document.querySelector(`input[name="attributeMap[${name}]"]`);
                if (!hidden) return null;

                // The interactive element shares the same id as the attribute name
                const el = document.getElementById(name);
                if (!el) return { type: 'hidden-only' };

                const tag = el.tagName.toLowerCase();
                const role = el.getAttribute('role') || '';
                const haspopup = el.getAttribute('aria-haspopup') || '';

                if (tag === 'button' && haspopup === 'dialog') return { type: 'dialog', id: name };
                if (tag === 'button' && role === 'combobox') return { type: 'combobox', id: name };
                if (tag === 'input' && role === 'combobox') return { type: 'autocomplete', id: name };
                if (tag === 'input') return { type: 'input', id: name };
                if (tag === 'select') return { type: 'select', id: name };

                return { type: 'unknown', id: name, tag, role };
            }, attrName);

            if (!info) return false;

            const escapedId = (info.id || '').replace(/\./g, '\\.');

            switch (info.type) {
                case 'combobox': {
                    // Open dropdown, find option by value, click it
                    await page.click(`#${escapedId}`);
                    await wait(300);
                    const selected = await page.evaluate((val) => {
                        const options = document.querySelectorAll('[role="option"]');
                        for (const opt of options) {
                            const optVal = opt.getAttribute('data-value') || '';
                            if (optVal === val) { opt.click(); return true; }
                        }
                        // Fallback: match by visible text (case-insensitive)
                        for (const opt of options) {
                            if (opt.textContent.trim().toLowerCase() === val.toLowerCase()) {
                                opt.click(); return true;
                            }
                        }
                        return false;
                    }, value);
                    if (!selected) await page.keyboard.press('Escape');
                    await wait(200);
                    return selected;
                }

                case 'dialog': {
                    // Condition-style: click button → dialog opens → select radio → confirm
                    await page.click(`#${escapedId}`);
                    await wait(500);
                    const confirmed = await page.evaluate((val) => {
                        const dialog = document.querySelector('dialog[aria-modal="true"]');
                        if (!dialog) return false;
                        // Find radio by value
                        const radios = dialog.querySelectorAll('input[type="radio"]');
                        for (const r of radios) {
                            if (r.value === val) { r.click(); break; }
                        }
                        // Also try clicking the label/option that contains the value
                        const options = dialog.querySelectorAll('[role="radio"], [role="option"]');
                        for (const opt of options) {
                            const optVal = opt.getAttribute('data-value') || opt.getAttribute('value') || '';
                            if (optVal === val) { opt.click(); break; }
                        }
                        // Click confirm button
                        const buttons = dialog.querySelectorAll('button');
                        for (const btn of buttons) {
                            const text = btn.textContent.trim().toLowerCase();
                            if (text.includes('bestätigen') || text.includes('übernehmen')) {
                                btn.click(); return true;
                            }
                        }
                        return false;
                    }, value);
                    await wait(300);
                    return confirmed;
                }

                case 'autocomplete': {
                    // Type into the search input, wait for dropdown, select match
                    const sel = `#${escapedId}`;
                    await page.click(sel);
                    // Clear existing value
                    await page.evaluate((s) => { document.querySelector(s).value = ''; }, sel);
                    await page.type(sel, value, { delay: 40 });
                    await wait(600);
                    const picked = await page.evaluate((val) => {
                        const options = document.querySelectorAll('[role="option"]');
                        for (const opt of options) {
                            if (opt.textContent.trim().toLowerCase() === val.toLowerCase()) {
                                opt.click(); return true;
                            }
                        }
                        return false;
                    }, value);
                    if (!picked) {
                        await page.keyboard.press('ArrowDown');
                        await page.keyboard.press('Enter');
                    }
                    await wait(300);
                    return true;
                }

                case 'select': {
                    await page.select(`#${escapedId}`, value);
                    return true;
                }

                case 'input': {
                    await typeInField(`#${escapedId}`, value);
                    return true;
                }

                default:
                    return false;
            }
        };

        console.log('Filling form data...');

        // --- 1. Title ---
        await typeInField(SELECTORS.title, adData.title);
        console.log(`- Title: ${adData.title}`);

        // --- 2. Description ---
        if (adData.description) {
            await page.waitForSelector(SELECTORS.description, { visible: true });
            await page.click(SELECTORS.description);
            await page.evaluate((sel) => { document.querySelector(sel).value = ''; }, SELECTORS.description);
            await page.type(SELECTORS.description, adData.description);
            console.log('- Description filled.');
        }

        // --- 3. Price ---
        await typeInField(SELECTORS.price, adData.price);
        console.log(`- Price: ${adData.price}`);

        // --- 4. Price type ---
        if (adData.priceType) {
            const priceTypeLabels = { 'FIXED': 'Festpreis', 'NEGOTIABLE': 'VB', 'GIVE_AWAY': 'Zu verschenken' };
            const label = priceTypeLabels[adData.priceType] || adData.priceType;
            await selectComboboxOption(page, SELECTORS.priceType, label);
            console.log(`- Price type: ${label}`);
        }

        // --- 5. Category-specific attributes (dynamicFields + autocompleteFields + condition) ---
        // Merge all attribute sources into a single map of { cleanName: value }
        const attributesToFill = {};

        if (adData.dynamicFields) {
            for (const [key, value] of Object.entries(adData.dynamicFields)) {
                attributesToFill[resolveAttributeName(key)] = value;
            }
        }
        if (adData.autocompleteFields) {
            for (const [key, value] of Object.entries(adData.autocompleteFields)) {
                // Old key "brands-input" → try to find the actual attribute name on the page
                const clean = resolveAttributeName(key);
                attributesToFill[clean] = value;
            }
        }
        // Condition from the top-level field (old format)
        if (adData.condition) {
            // Find the condition attribute name on the page (e.g. kleidung_herren.condition)
            const condAttr = await page.evaluate(() => {
                const el = document.querySelector('input[name*=".condition"]');
                if (!el) return null;
                const match = el.name.match(/attributeMap\[(.+)\]/);
                return match ? match[1] : null;
            });
            if (condAttr) {
                attributesToFill[condAttr] = adData.condition;
            }
        }

        // Now fill each attribute
        console.log('- Filling category attributes...');
        for (const [attrName, value] of Object.entries(attributesToFill)) {
            try {
                const ok = await fillAttribute(attrName, value);
                if (ok) {
                    console.log(`  ✓ ${attrName}: ${value}`);
                } else {
                    // Try the old ID as-is (backward compat for unknown fields)
                    console.log(`  · ${attrName}: not found on form, skipping`);
                }
            } catch (e) {
                console.warn(`  ✗ ${attrName}: ${e.message}`);
            }
        }

        // --- 6. Shipping methods ---
        // If versand is "ja", the shipping options section appears.
        // We need to open the dialog, select the right package size, pick carriers, and confirm.
        const versandValue = attributesToFill[Object.keys(attributesToFill).find(k => k.includes('versand'))] || '';
        if (versandValue === 'ja') {
            await wait(500); // Let the shipping section render after versand radio change

            // Read desired shipping option IDs from data or use defaults
            // The form stores them as shippingOptions[0].id = "HERMES_003", etc.
            const shippingOptionIds = adData.shippingOptions || [];

            if (shippingOptionIds.length > 0) {
                try {
                    // Click the shipping options button to open the dialog
                    const shippingBtn = await page.$('#ad-shipping-options');
                    if (shippingBtn) {
                        await shippingBtn.click();
                        await wait(500);

                        // The dialog opens with recommended options pre-checked.
                        // Click "Andere Versandmethoden" to see all size options.
                        const clickedOther = await page.evaluate(() => {
                            const links = document.querySelectorAll('a, button');
                            for (const el of links) {
                                if (el.textContent.includes('Andere Versandmethoden')) {
                                    el.click(); return true;
                                }
                            }
                            return false;
                        });

                        if (clickedOther) {
                            await wait(400);

                            // Determine the package size from the option IDs
                            // HERMES_001/002, DHL_001 = SMALL; HERMES_003, DHL_002 = MEDIUM; HERMES_004, DHL_003+ = LARGE
                            const sizeMap = {
                                'HERMES_001': 'Klein', 'HERMES_002': 'Klein',
                                'DHL_001': 'Klein',
                                'HERMES_003': 'Mittel', 'DHL_002': 'Mittel',
                                'HERMES_004': 'Groß', 'DHL_003': 'Groß',
                                'DHL_004': 'Groß', 'DHL_005': 'Groß'
                            };
                            const targetSize = sizeMap[shippingOptionIds[0]] || 'Mittel';

                            // Select the package size radio
                            await page.evaluate((size) => {
                                const labels = document.querySelectorAll('label');
                                for (const label of labels) {
                                    const text = label.textContent.trim();
                                    if (text.startsWith(size)) {
                                        const radio = label.querySelector('input[type="radio"]');
                                        if (radio) radio.click();
                                        else label.click();
                                        return;
                                    }
                                }
                            }, targetSize);
                            await wait(300);

                            // Click "Weiter" to go to carrier selection
                            await page.evaluate(() => {
                                const buttons = document.querySelectorAll('button');
                                for (const btn of buttons) {
                                    if (btn.textContent.trim() === 'Weiter') { btn.click(); return; }
                                }
                            });
                            await wait(500);

                            // Now check the specific carrier options by matching their IDs in the text
                            // Each option card has a checkbox and text like "Hermes M-Paket"
                            for (const optId of shippingOptionIds) {
                                await page.evaluate((id) => {
                                    // Map option IDs to display names
                                    const nameMap = {
                                        'HERMES_001': 'Hermes Päckchen', 'HERMES_002': 'Hermes S-Paket',
                                        'HERMES_003': 'Hermes M-Paket', 'HERMES_004': 'Hermes L-Paket',
                                        'DHL_001': 'DHL Paket 2 kg', 'DHL_002': 'DHL Paket 5 kg',
                                        'DHL_003': 'DHL Paket 10 kg', 'DHL_004': 'DHL Paket 31,5 kg',
                                        'DHL_005': 'DHL Paket 20 kg'
                                    };
                                    const name = nameMap[id];
                                    if (!name) return;

                                    // Find the checkbox/label containing this name
                                    const allLabels = document.querySelectorAll('label');
                                    for (const label of allLabels) {
                                        if (label.textContent.includes(name)) {
                                            const cb = label.querySelector('input[type="checkbox"]');
                                            if (cb && !cb.checked) cb.click();
                                            else if (!cb) label.click();
                                            return;
                                        }
                                    }
                                }, optId);
                            }
                            await wait(200);

                            // Click "Fertig" or "Bestätigen" to confirm
                            await page.evaluate(() => {
                                const buttons = document.querySelectorAll('button');
                                for (const btn of buttons) {
                                    const text = btn.textContent.trim();
                                    if (text === 'Fertig' || text === 'Bestätigen') {
                                        btn.click(); return;
                                    }
                                }
                            });
                            await wait(300);
                            console.log(`- Shipping: ${shippingOptionIds.join(', ')}`);
                        } else {
                            // No "Andere Versandmethoden" link — just confirm the defaults
                            await page.evaluate(() => {
                                const buttons = document.querySelectorAll('button');
                                for (const btn of buttons) {
                                    if (btn.textContent.trim() === 'Bestätigen') { btn.click(); return; }
                                }
                            });
                            await wait(300);
                            console.log('- Shipping: confirmed defaults');
                        }
                    }
                } catch (e) {
                    console.warn(`  ... Shipping setup issue: ${e.message}`);
                }
            }
        }

        // --- 7. ZIP code + city district ---
        if (adData.zipCode) {
            await typeInField(SELECTORS.zipCode, adData.zipCode);
            console.log(`- ZIP: ${adData.zipCode}`);
            await wait(1500);

            // Select city district
            const targetCity = adData.city || 'Dortmund - Mitte';
            const currentCity = await page.evaluate(() => {
                const el = document.getElementById('ad-city-selected-option');
                return el ? el.textContent.trim() : '';
            });
            if (currentCity !== targetCity) {
                console.log(`- City: "${currentCity}" → "${targetCity}"`);
                await selectComboboxOption(page, '#ad-city', targetCity);
            } else {
                console.log(`- City: ${currentCity}`);
            }
        }

        // --- 8. Street ---
        if (adData.street) {
            try {
                const streetDisabled = await page.$eval(SELECTORS.street, el => el.disabled);
                if (streetDisabled) {
                    await page.click(SELECTORS.addressVisibility);
                    await wait(300);
                }
                await typeInField(SELECTORS.street, adData.street);
                console.log(`- Street: ${adData.street}`);
            } catch (e) {
                console.warn(`  ... Could not fill street: ${e.message}`);
            }
        }

        // --- 9. Photo upload ---
        if (photoFiles.length > 0) {
            console.log(`- Uploading ${photoFiles.length} images...`);
            try {
                const fileInput = await page.$(SELECTORS.photoUploadInput);
                if (fileInput) {
                    await fileInput.uploadFile(...photoFiles);
                    console.log('  ... images submitted.');
                    await wait(5000);
                } else {
                    const [fileChooser] = await Promise.all([
                        page.waitForFileChooser({ timeout: 5000 }),
                        page.evaluate(() => {
                            const btn = document.querySelector('button:has(svg[data-title="addImage"])');
                            if (btn) btn.click();
                        })
                    ]);
                    await fileChooser.accept(photoFiles);
                    await wait(5000);
                }
                console.log('  ... images uploaded.');
            } catch (e) {
                console.warn(`  ... Photo upload issue: ${e.message}. Check manually.`);
            }
        } else {
            console.log('- No images found in template folder.');
        }

        console.log('\n---\n✅ Automation complete! Please review the ad and post it manually.\n---');

    } catch (error) {
        console.error('An error occurred during automation:', error);
    } finally {
        if (browser) await browser.disconnect();
    }
}

// --- SCRIPT ENTRY POINT ---
async function main() {
    console.log('--- Kleinanzeigen Automator ---');

    while (true) {
        const modeChoice = await askQuestion('\n--> Choose a mode: [1] Run (Post Ad), [2] Capture (New Template), or [3] Exit: ');

        if (modeChoice.trim() === '1') {
            await runAutomation();
        } else if (modeChoice.trim() === '2') {
            await captureData();
        } else if (modeChoice.trim() === '3') {
            console.log('Exiting. Goodbye!');
            rl.close();
            break;
        } else {
            console.log('Invalid choice. Please enter 1, 2, or 3.');
        }
    }
}

main().catch(err => {
    console.error("A critical error occurred:", err);
    rl.close();
});
