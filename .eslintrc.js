module.exports = {
	parser: '@typescript-eslint/parser',
	parserOptions: {
		ecmaVersion: 2020,
		sourceType: 'module',
	},
	ignorePatterns: ['dist/**/*', 'node_modules/**/*'],
	plugins: ['n8n-nodes-base'],
	extends: ['plugin:n8n-nodes-base/community'],
	rules: {
		'n8n-nodes-base/community-package-json-name-still-default': 'off',
	},
};
