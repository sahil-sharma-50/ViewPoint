/** @type {import('next').NextConfig} */
export default {
  typescript: { tsconfigPath: 'tsconfig.web.json' },
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};
