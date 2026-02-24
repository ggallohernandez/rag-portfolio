const basePath = normalizeBasePath(process.env.BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? "/");
const hasCustomBasePath = basePath !== "/";

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "export",
  basePath: hasCustomBasePath ? basePath : undefined,
  assetPrefix: hasCustomBasePath ? `${basePath}/` : undefined,
  images: {
    unoptimized: true
  },
  typescript: {
    tsconfigPath: "./tsconfig.next.json"
  }
};

export default nextConfig;

function normalizeBasePath(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");
  return withoutTrailingSlash.length > 0 ? withoutTrailingSlash : "/";
}
