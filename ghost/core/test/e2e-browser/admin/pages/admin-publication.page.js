const AdminPage = require('./admin-page');

class AdminPublicationPage extends AdminPage {
    #defaultLanguage = 'en';
    #languageSection = null;
    #saveButton = null;

    /**
     * @param {import('@playwright/test').Page} page - playwright page object
     */
    constructor(page) {
        super(page, '/ghost/#/settings/publication-language');

        this.#languageSection = this.page.getByTestId('publication-language');
        this.#saveButton = this.#languageSection.getByRole('button', {name: 'Save'});
    }

    get languageField() {
        // Returns either the text input (custom mode) or the hidden input from select
        return this.#languageSection.getByTestId('locale-select');
    }

    async setLanguage(language) {
        if (!language || typeof language !== 'string' || language.trim().length === 0) {
            throw new Error('Language must be a non-empty string');
        }

        const trimmedLanguage = language.trim();

        // If we're currently in custom input mode, click "Choose from list" first
        const backToListButton = this.#languageSection.getByRole('button', {name: 'Choose from list'});
        const isBackButtonVisible = await backToListButton.isVisible().catch(() => false);
        if (isBackButtonVisible) {
            await backToListButton.click();
        }

        // Open the dropdown
        const select = this.#languageSection.getByTestId('locale-select');
        await select.click();

        // Try to find the language in the dropdown options (format: "Label (code)")
        const optionWithCode = this.page.locator('[data-testid="select-option"]').filter({hasText: `(${trimmedLanguage})`});
        const optionExists = await optionWithCode.count() > 0;

        if (optionExists) {
            // Select from dropdown
            await optionWithCode.first().click();
        } else {
            // Use "Other..." for custom values
            await this.page.locator('[data-testid="select-option"]').filter({hasText: 'Other'}).click();
            await this.#languageSection.locator('input[type="text"]').fill(trimmedLanguage);
        }

        await this.#saveButton.click();
    }

    async resetToDefaultLanguage() {
        // Check if we're in custom input mode
        const backToListButton = this.#languageSection.getByRole('button', {name: 'Choose from list'});
        const isBackButtonVisible = await backToListButton.isVisible().catch(() => false);

        if (isBackButtonVisible) {
            // Click "Choose from list" to go back to dropdown mode
            await backToListButton.click();
        }

        // Now select "en" from the dropdown
        const select = this.#languageSection.getByTestId('locale-select');
        await select.click();

        // Select English (en) from the options
        await this.page.locator('[data-testid="select-option"]').filter({hasText: 'English (en)'}).click();

        await this.#saveButton.click();
    }
}

module.exports = AdminPublicationPage;
