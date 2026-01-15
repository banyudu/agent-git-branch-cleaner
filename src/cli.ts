export interface CliArgs {
  repoPath?: string;
  configPath?: string;
  excludePatterns: string[];
  staleDays?: number;
  help: boolean;
}

export function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    excludePatterns: [],
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "-h":
      case "--help":
        result.help = true;
        break;

      case "-p":
      case "--path":
        result.repoPath = args[++i];
        break;

      case "-c":
      case "--config":
        result.configPath = args[++i];
        break;

      case "-e":
      case "--exclude":
        // Support multiple exclude patterns
        const pattern = args[++i];
        if (pattern) {
          result.excludePatterns.push(pattern);
        }
        break;

      case "-s":
      case "--stale-days":
        const days = parseInt(args[++i], 10);
        if (!isNaN(days)) {
          result.staleDays = days;
        }
        break;

      default:
        // If it's a path without a flag, treat it as the repo path
        if (!arg.startsWith("-") && !result.repoPath) {
          result.repoPath = arg;
        }
        break;
    }
  }

  if (result.help) {
    printHelp();
    process.exit(0);
  }

  return result;
}

function printHelp(): void {
  console.log(`
🧹 Git Branch Cleaner Agent

An AI-powered tool to safely clean up unnecessary git branches.

USAGE:
  git-branch-cleaner [OPTIONS] [REPO_PATH]

OPTIONS:
  -h, --help              Show this help message
  -p, --path <path>       Path to the git repository (default: current directory)
  -c, --config <path>     Path to config file (default: .branchcleanerrc in repo)
  -e, --exclude <pattern> Exclude branches matching pattern (can be used multiple times)
  -s, --stale-days <days> Days of inactivity to consider a branch stale (default: 30)

EXAMPLES:
  # Clean branches in current directory
  git-branch-cleaner

  # Clean branches in a specific repo
  git-branch-cleaner /path/to/repo

  # Exclude preview branches
  git-branch-cleaner --exclude "preview-*"

  # Multiple exclusions with custom stale threshold
  git-branch-cleaner -e "release-*" -e "hotfix-*" -s 60

CONFIG FILE:
  Create a .branchcleanerrc file in your repo root:
  {
    "excludePatterns": ["preview-*", "release-*"],
    "staleDays": 30,
    "protectedBranches": ["custom-protected"]
  }

PROTECTED BRANCHES (never deleted):
  main, master, dev, develop, development,
  stage, staging, prod, production, preview, release
`);
}
