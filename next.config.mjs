/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "export",
  images: {
    unoptimized: true
  },
  typescript: {
    tsconfigPath: "./tsconfig.next.json"
  }
};

export default nextConfig;
