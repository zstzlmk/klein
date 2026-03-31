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
const SELECTORS = {
    title: '#postad-title',
    description: '#pstad-descrptn',
    price: '#micro-frontend-price',
    priceType: '#micro-frontend-price-type',
    zipCode: '#pstad-zip',
    street: '#pstad-street',
    categoryPath: '#postad-category-path',
    art: '#kleidung_herren\\.art_s',
    brand: '#brands-input',
    size: '#kleidung_herren\\.groesse_s',
    color: '#kleidung_herren\\.color_s',
    conditionOpenButton: '#j-post-listing-frontend-conditions button[aria-haspopup="true"]',
    conditionRadioButton: (value) => `#radio-button-${value}`,
    conditionConfirmButton: 'dialog[aria-modal="true"] button ::-p-text(Bestätigen)',
    shippingRadioButton: (value) => `#radio-${value}`,
    photoUploadButton: '#pictureupload-pickfiles-icon', // The visible '+' button for adding photos
    photoUploadInput: '#plupld input[type="file"]',
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
        console.error('Please ensure you have launched Chrome with the remote debugging flag before running this script.');
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
        const pages = await browser.pages();
        let page = null;
        for (const p of pages) {
            if (p.url().includes('kleinanzeigen.de')) {
                try {
                    await p.waitForSelector(SELECTORS.title, { visible: true, timeout: 1000 });
                    page = p;
                    console.log("Found correct ad details page.");
                    break;
                } catch (e) {
                    continue;
                }
            }
        }
        
        if (!page) {
            throw new Error('Could not find the Kleinanzeigen ad details page. Please manually navigate there before running capture.');
        }
        await page.bringToFront();

        console.log('Capturing data from the form...');
        const adData = await page.evaluate((selectors) => {
            const data = {};
            const getVal = (selector) => {
                try {
                    return document.querySelector(selector)?.value || '';
                } catch (e) {
                    return '';
                }
            };

            // Capture essential fields
            data.title = getVal(selectors.title);
            data.description = getVal(selectors.description);
            data.price = getVal(selectors.price);
            data.priceType = getVal(selectors.priceType);
            data.zipCode = getVal(selectors.zipCode);
            data.street = getVal(selectors.street);

            // Capture category information
            const categoryPathElement = document.querySelector('#postad-category-path');
            if (categoryPathElement && categoryPathElement.textContent.trim()) {
                data.categoryPath = categoryPathElement.textContent.trim();
            }

            // Capture city district (location)
            const cityChooser = document.querySelector('#pstad-citychsr');
            if (cityChooser && cityChooser.value) {
                data.locationId = cityChooser.value;
            }

            // Capture condition
            const conditionRadio = document.querySelector('#j-post-listing-frontend-conditions input[name="condition"]:checked');
            data.condition = conditionRadio ? conditionRadio.value : '';

            // UNIVERSAL FIELD CAPTURE: Capture all select dropdowns and inputs
            data.dynamicFields = {};
            data.autocompleteFields = {};

            // Fields to exclude from capture (already handled separately or duplicates)
            const excludedFields = [
                'micro-frontend-price-type', 'priceType', 'pstad-price', 'micro-frontend-price',
                'postad-title', 'pstad-descrptn', 'pstad-zip', 'pstad-street',
                'pstad-citychsr', 'postad-contactname'
            ];

            // Capture all select elements (dropdowns) in the form
            const selects = document.querySelectorAll('select');
            selects.forEach(select => {
                if (select.id && select.value && !excludedFields.includes(select.id)) {
                    data.dynamicFields[select.id] = select.value;
                }
            });

            // Capture all text inputs with specific patterns (like brand autocomplete)
            const textInputs = document.querySelectorAll('input[type="text"]');
            textInputs.forEach(input => {
                if (input.id && input.value && !excludedFields.includes(input.id)) {
                    // Check if this is an autocomplete field (like brands)
                    if (input.hasAttribute('role') && input.getAttribute('role') === 'combobox') {
                        data.autocompleteFields[input.id] = input.value;
                    } else {
                        data.dynamicFields[input.id] = input.value;
                    }
                }
            });

            return data;
        }, SELECTORS);

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
        const pages = await browser.pages();
        let page = null;
        let needsCategorySelection = false;

        for (const p of pages) {
            if (p.url().includes('kleinanzeigen.de')) {
                try {
                    // Check if the title field is visible on this page, which confirms it's the right one.
                    await p.waitForSelector(SELECTORS.title, { visible: true, timeout: 1000 });
                    page = p;
                    console.log("Found correct ad details page.");
                    break;
                } catch (e) {
                    // Check if we're on the category selection page or initial ad page
                    try {
                        await p.waitForSelector('#pstad-lnk-chngeCtgry', { visible: true, timeout: 1000 });
                        page = p;
                        needsCategorySelection = true;
                        console.log("Found ad page, category needs to be selected.");
                        break;
                    } catch (e2) {
                        continue;
                    }
                }
            }
        }

        if (!page) {
             throw new Error('Could not find the Kleinanzeigen ad page. Please navigate to the ad posting page before running the script.');
        }
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

        // Handle category selection if needed
        if (adData.categoryPath) {
            // Extract the art field from dynamicFields if it exists
            let artValue = null;
            if (adData.dynamicFields) {
                // Look for any field that might be the "art" selector for categories
                const artFieldKeys = Object.keys(adData.dynamicFields).filter(key =>
                    key.includes('.art_s') || key.includes('art')
                );
                if (artFieldKeys.length > 0) {
                    artValue = adData.dynamicFields[artFieldKeys[0]];
                }
            }

            if (needsCategorySelection) {
                // We're on the initial page before any category is selected
                await selectCategory(page, adData.categoryPath, artValue);
            } else {
                // We're on the form page, but check if category needs to be selected/changed
                const categoryEmpty = await page.evaluate(() => {
                    const categoryPath = document.querySelector('#postad-category-path');
                    return !categoryPath || !categoryPath.textContent.trim();
                });

                if (categoryEmpty) {
                    // Category is not selected yet, select it
                    await selectCategory(page, adData.categoryPath, artValue);
                }
            }
        }

        await page.waitForSelector(SELECTORS.title, { visible: true });
        
        console.log('Filling form data...');
        
        // Use a simple, reliable method to clear and type
        const typeInField = async (selector, text) => {
            if (text !== undefined && text !== null && text !== '') {
                await page.waitForSelector(selector, { visible: true });
                await page.click(selector, { clickCount: 3 });
                await page.keyboard.press('Backspace');
                await page.type(selector, text);
            }
        };
        
        await typeInField(SELECTORS.title, adData.title);
        await typeInField(SELECTORS.description, adData.description);
        await typeInField(SELECTORS.price, adData.price);

        if (adData.priceType) {
             await page.select(SELECTORS.priceType, adData.priceType);
        }

        // UNIVERSAL FIELD FILLING: Fill all dynamic fields
        if (adData.dynamicFields) {
            console.log('- Filling dynamic category-specific fields...');
            for (const [fieldId, fieldValue] of Object.entries(adData.dynamicFields)) {
                try {
                    // Escape special characters in CSS selector (dots, colons, etc.)
                    const escapedId = fieldId.replace(/[:.]/g, '\\$&');
                    const selector = `#${escapedId}`;

                    const fieldExists = await page.$(selector);
                    if (fieldExists) {
                        const fieldType = await page.evaluate((id) => {
                            const el = document.getElementById(id);
                            return el ? el.tagName.toLowerCase() : null;
                        }, fieldId);

                        if (fieldType === 'select') {
                            // For select, we can use page.select with the original ID
                            await page.select(selector, fieldValue);
                            console.log(`  ... ${fieldId}: ${fieldValue}`);
                        } else if (fieldType === 'input') {
                            await typeInField(selector, fieldValue);
                            console.log(`  ... ${fieldId}: ${fieldValue}`);
                        }
                    }
                } catch (e) {
                    console.warn(`  ... Could not fill field ${fieldId}: ${e.message}`);
                }
            }
        }

        if (adData.condition) {
            console.log(`- Selecting condition: ${adData.condition}`);
            await page.click(SELECTORS.conditionOpenButton);
            await page.waitForSelector(SELECTORS.conditionConfirmButton, { visible: true });
            await page.click(SELECTORS.conditionRadioButton(adData.condition));
            await page.click(SELECTORS.conditionConfirmButton);
            await page.waitForSelector(SELECTORS.conditionConfirmButton, { hidden: true });
            console.log('  ... condition selected.');
        }

        await typeInField(SELECTORS.zipCode, adData.zipCode);

        // Wait for city dropdown to populate after ZIP code is entered
        if (adData.locationId) {
            await new Promise(resolve => setTimeout(resolve, 800)); // Wait for dropdown to populate
            try {
                const cityDropdownExists = await page.$('#pstad-citychsr');
                if (cityDropdownExists) {
                    await page.select('#pstad-citychsr', adData.locationId);
                    console.log(`- Selected city district: ${adData.locationId}`);
                }
            } catch (e) {
                console.warn(`  ... Could not select city district: ${e.message}`);
            }
        }

        if (adData.street) {
             await typeInField(SELECTORS.street, adData.street);
        }
        
        // Handle photo upload
        if (photoFiles.length > 0) {
            console.log(`- Uploading ${photoFiles.length} images...`);
            try {
                const [fileChooser] = await Promise.all([
                    page.waitForFileChooser(),
                    page.click(SELECTORS.photoUploadButton) // Click the visible '+' icon
                ]);
                await fileChooser.accept(photoFiles);

                // Wait for a thumbnail to appear, which confirms an upload has started/finished processing
                // Reduced timeout to 15 seconds - if it takes longer, something is wrong
                await page.waitForSelector('.pictureupload-thumbnails .imagebox-new-thumbnail--cover', { visible: true, timeout: 15000 });
                console.log('  ... images uploaded.');
            } catch (e) {
                console.warn('  ... Photo upload may have timed out, but continuing. Check manually if photos uploaded.');
            }
        } else {
            console.log('- No images found in the template folder to upload.');
        }

        // Handle autocomplete fields (like brand) at the very end
        if (adData.autocompleteFields) {
            for (const [fieldId, fieldValue] of Object.entries(adData.autocompleteFields)) {
                try {
                    console.log(`- Selecting autocomplete field ${fieldId}: ${fieldValue}`);
                    await page.click(`#${fieldId}`);
                    await page.type(`#${fieldId}`, fieldValue, { delay: 50 });

                    // Wait for dropdown to appear - try multiple possible dropdown patterns
                    await new Promise(resolve => setTimeout(resolve, 500));

                    // Try to click the matching option
                    const clicked = await page.evaluate((fValue) => {
                        // Try different dropdown selectors
                        const dropdownSelectors = [
                            'ul[role="listbox"] li[role="option"]',
                            'ul li[role="option"]',
                            '[role="option"]'
                        ];

                        for (const selector of dropdownSelectors) {
                            const options = Array.from(document.querySelectorAll(selector));
                            if (options.length > 0) {
                                const targetOption = options.find(option =>
                                    option.textContent.trim().toLowerCase() === fValue.trim().toLowerCase()
                                );
                                if (targetOption) {
                                    targetOption.click();
                                    return true;
                                }
                            }
                        }
                        return false;
                    }, fieldValue);

                    if (clicked) {
                        console.log(`  ... ${fieldId} selected.`);
                    } else {
                        console.warn(`  ... Could not find exact match for "${fieldValue}". Attempting fallback...`);
                        await page.keyboard.press('ArrowDown');
                        await page.keyboard.press('Enter');
                        console.log('  ... Fallback completed.');
                    }
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (e) {
                    console.warn(`  ... Could not fill autocomplete field ${fieldId}: ${e.message}`);
                }
            }
        }

        console.log('\n---\n✅ Automation complete! Please review the ad and post it manually.\n---');

    } catch (error) {
        console.error('An error occurred during automation:', error);
    } finally {
        if (browser) await browser.disconnect();
    }
}

// --- CATEGORY SELECTION HELPER ---
async function selectCategory(page, categoryPath, art) {
    console.log('Selecting category...');

    // Helper function to wait (replaces deprecated waitForTimeout)
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Click on "Wähle deine Kategorie" link
    await page.waitForSelector('#pstad-lnk-chngeCtgry', { visible: true });
    await page.click('#pstad-lnk-chngeCtgry');

    // Wait for category selection page to load
    await page.waitForSelector('#postad-category-select-box', { visible: true });
    await wait(1000);

    // Parse the category path (e.g., "Mode & Beauty > Herrenbekleidung")
    const parts = categoryPath.split('>').map(s => s.trim());

    if (parts.length >= 2) {
        const mainCategory = parts[0]; // e.g., "Mode & Beauty"
        const subCategory = parts[1];  // e.g., "Herrenbekleidung"

        console.log(`- Main category: ${mainCategory}`);
        console.log(`- Sub category: ${subCategory}`);
        if (art) console.log(`- Art: ${art}`);

        // Step 1: Click the main category
        console.log(`  Clicking main category: ${mainCategory}`);
        const mainCategorySelector = await page.evaluate((mainCat) => {
            const links = Array.from(document.querySelectorAll('.category-selection-list-item-link'));
            const match = links.find(link => link.textContent.trim() === mainCat);
            if (match && match.id) {
                return `#${match.id}`;
            }
            return null;
        }, mainCategory);

        if (!mainCategorySelector) {
            throw new Error(`Could not find main category: ${mainCategory}`);
        }

        await page.click(mainCategorySelector);
        await wait(800); // Wait for subcategories to load

        // Step 2: Click the sub category
        console.log(`  Clicking sub category: ${subCategory}`);
        const subCategorySelector = await page.evaluate((subCat) => {
            const links = Array.from(document.querySelectorAll('.category-selection-list-item-link'));
            const match = links.find(link => link.textContent.trim() === subCat);
            if (match && match.id) {
                return `#${match.id}`;
            }
            return null;
        }, subCategory);

        if (!subCategorySelector) {
            throw new Error(`Could not find sub category: ${subCategory}`);
        }

        await page.click(subCategorySelector);
        await wait(800); // Wait for art categories to load

        // Step 3: Click on art if provided
        if (art) {
            console.log(`  Clicking art: ${art}`);
            const artSelector = `#cat_${art}`;

            try {
                await page.waitForSelector(artSelector, { visible: true, timeout: 2000 });
                await page.click(artSelector);
                await wait(500);
            } catch (e) {
                // Fallback: try to find it by href
                const artFound = await page.evaluate((artValue) => {
                    const links = Array.from(document.querySelectorAll('.category-selection-list-item-link'));
                    const match = links.find(link => {
                        const href = link.getAttribute('href') || '';
                        return href.includes(artValue);
                    });
                    if (match) {
                        match.click();
                        return true;
                    }
                    return false;
                }, art);

                if (!artFound) {
                    console.warn(`Warning: Could not find art category: ${art}, continuing anyway...`);
                }

                await wait(500);
            }
        }
    }

    // Step 4: Click "Weiter" button to proceed
    console.log('  Clicking Weiter button...');
    await page.waitForSelector('button[type="submit"]', { visible: true });
    await page.click('button[type="submit"]');

    // Wait for the form page to load
    await page.waitForSelector(SELECTORS.title, { visible: true });
    await wait(1000);

    console.log('  ... category selected successfully!');
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