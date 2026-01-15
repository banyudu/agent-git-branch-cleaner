import * as fs from "fs";
import * as path from "path";

export interface Config {
  excludePatterns: string[];
  staleDays: number;
  protectedBranches: string[];
}

const DEFAULT_CONFIG: Config = {
  excludePatterns: [],
  staleDays: 30,
  protectedBranches: [
    "main",
    "master",
    "dev",
    "develop",
    "development",
    "stage",
    "staging",
    "prod",
    "production",
    "preview",
    "release",
  ],
};

const CONFIG_FILE_NAMES = [
  ".branchcleanerrc",
  ".branchcleanerrc.json",
  ".branchcleaner.json",
  "branchcleaner.config.json",
];

export async function loadConfig(customPath?: string): Promise<Config> {
  let configPath: string | undefined;

  if (customPath) {
    // Use custom path if provided
    configPath = path.resolve(customPath);
    if (!fs.existsSync(configPath)) {
      console.warn(`Warning: Config file not found at ${configPath}, using defaults`);
      return { ...DEFAULT_CONFIG };
    }
  } else {
    // Search for config file in current directory
    const cwd = process.cwd();
    for (const fileName of CONFIG_FILE_NAMES) {
      const filePath = path.join(cwd, fileName);
      if (fs.existsSync(filePath)) {
        configPath = filePath;
        break;
      }
    }
  }

  if (!configPath) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const userConfig = JSON.parse(content) as Partial<Config>;

    console.log(`📋 Loaded config from: ${configPath}`);

    return {
      excludePatterns: [
        ...DEFAULT_CONFIG.protectedBranches,
        ...(userConfig.excludePatterns ?? []),
      ],
      staleDays: userConfig.staleDays ?? DEFAULT_CONFIG.staleDays,
      protectedBranches: [
        ...DEFAULT_CONFIG.protectedBranches,
        ...(userConfig.protectedBranches ?? []),
      ],
    };
  } catch (error) {
    console.warn(`Warning: Failed to parse config file: ${error}`);
    return { ...DEFAULT_CONFIG };
  }
}

export function matchesExcludePattern(branchName: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlobPattern(branchName, pattern)) {
      return true;
    }
  }
  return false;
}

function matchGlobPattern(str: string, pattern: string): boolean {
  // Exact match
  if (str === pattern) {
    return true;
  }

  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape special chars except * and ?
    .replace(/\*/g, ".*") // * matches any characters
    .replace(/\?/g, "."); // ? matches single character

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(str);
}
