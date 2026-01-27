const fioriTools  = require('@sap-ux/eslint-plugin-fiori-tools');

module.exports = [
    ...fioriTools.configs.recommended,
    {
        // Ignore TypeScript declaration files
        ignores: ["**/*.d.ts"]
    },
    {
        // Relax strict TypeScript rules for UI5 event handling
        files: ["**/*.ts"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/no-unnecessary-type-assertion": "off",
            "@sap-ux/fiori-tools/sap-no-navigator": "off"
        }
    },
    {
        // Allow module-level constants in wallet service (non-UI5 code)
        files: ["**/wallet/**/*.ts"],
        rules: {
            "@sap-ux/fiori-tools/sap-no-global-variable": "off"
        }
    }
];
