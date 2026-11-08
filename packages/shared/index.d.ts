export interface AndroidIdentity {
  applicationId: string;
  storagePrefix: string;
  deepLinkScheme: string;
  apkStem: string;
}

export interface ProductIdentity {
  productName: string;
  tagline: string;
  repoSlug: string;
  themeColor: string;
  backgroundColor: string;
  cliName: string;
  android?: AndroidIdentity;
}

export declare const IDENTITY: ProductIdentity;
export declare const PRODUCT_NAME: string;
export declare const TAGLINE: string;
export declare const THEME_COLOR: string;
export declare const BACKGROUND_COLOR: string;
export declare const CLI_NAME: string;
export declare const REPO_SLUG: string;
export declare const APP_SLUG: string;
