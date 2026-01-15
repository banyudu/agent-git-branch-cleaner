#!/usr/bin/env node

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execSync } from "child_process";
import * as readline from "readline";
import { parseArgs } from "./cli.js";
import { loadConfig } from "./config.js";

// ANSI color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

// Verbose logging flag
const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

function log(prefix: string, color: string, message: string) {
  console.log(`${color}${prefix}${colors.reset} ${message}`);
}

function logVerbose(prefix: string, color: string, message: string) {
  if (verbose) {
    log(prefix, color, message);
  }
}

// Helper to execute git commands
function execGit(command: string, cwd: string): string {
  try {
    return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (error instanceof Error && "stderr" in error) {
      throw new Error(`Git command failed: ${(error as { stderr: string }).stderr}`);
    }
    throw error;
  }
}

// Helper to prompt user for input
function promptUser(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${colors.cyan}${prompt}${colors.reset} `, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Helper to ask user for confirmation (used by ask_confirmation tool)
async function askUserConfirmation(message: string, branches: string[]): Promise<boolean> {
  console.log("\n" + "=".repeat(50));
  console.log(`${colors.yellow}⚠️  CONFIRMATION REQUIRED${colors.reset}`);
  console.log("=".repeat(50));
  console.log(message);
  console.log("\nBranches to be deleted:");
  branches.forEach((b) => console.log(`  ${colors.red}- ${b}${colors.reset}`));
  console.log();

  const answer = await promptUser("Do you want to proceed? (yes/no):");
  const confirmed = answer.toLowerCase() === "yes" || answer.toLowerCase() === "y";
  console.log(confirmed ? `${colors.green}✅ Confirmed${colors.reset}` : `${colors.red}❌ Cancelled${colors.reset}`);
  return confirmed;
}

// Create MCP server with tools
function createBranchCleanerMcpServer(repoPath: string) {
  return createSdkMcpServer({
    name: "git-branch-cleaner",
    version: "1.0.0",
    tools: [
      tool(
        "list_branches",
        "List all git branches (local and/or remote) with their last commit dates. Returns branch name, last commit date, and commit hash.",
        {
          include_local: z.boolean().optional().describe("Include local branches (default: true)"),
          include_remote: z.boolean().optional().describe("Include remote branches (default: true)"),
        },
        async ({ include_local = true, include_remote = true }) => {
          const branches: Array<{
            name: string;
            type: "local" | "remote";
            lastCommitDate: string;
            commitHash: string;
          }> = [];

          if (include_local) {
            const localOutput = execGit(
              'git for-each-ref --sort=-committerdate refs/heads/ --format="%(refname:short)|%(committerdate:iso)|%(objectname:short)"',
              repoPath
            );
            if (localOutput) {
              for (const line of localOutput.split("\n")) {
                const [name, date, hash] = line.split("|");
                if (name) {
                  branches.push({ name, type: "local", lastCommitDate: date, commitHash: hash });
                }
              }
            }
          }

          if (include_remote) {
            try {
              execGit("git fetch --prune", repoPath);
            } catch {
              // Ignore fetch errors
            }

            const remoteOutput = execGit(
              'git for-each-ref --sort=-committerdate refs/remotes/ --format="%(refname:short)|%(committerdate:iso)|%(objectname:short)"',
              repoPath
            );
            if (remoteOutput) {
              for (const line of remoteOutput.split("\n")) {
                const [name, date, hash] = line.split("|");
                if (name && !name.endsWith("/HEAD")) {
                  branches.push({ name, type: "remote", lastCommitDate: date, commitHash: hash });
                }
              }
            }
          }

          return { content: [{ type: "text" as const, text: JSON.stringify(branches, null, 2) }] };
        }
      ),

      tool(
        "check_merged_status",
        "Check if a branch has been merged into the main/master branch.",
        { branch_name: z.string().describe("The branch name to check") },
        async ({ branch_name }) => {
          let mainBranch = "main";
          try {
            execGit("git rev-parse --verify main", repoPath);
          } catch {
            try {
              execGit("git rev-parse --verify master", repoPath);
              mainBranch = "master";
            } catch {
              return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Could not find main or master branch", merged: false }) }] };
            }
          }

          try {
            const mergedBranches = execGit(`git branch --merged ${mainBranch}`, repoPath);
            const isMerged = mergedBranches.split("\n").some((b) => b.trim().replace("* ", "") === branch_name);
            return { content: [{ type: "text" as const, text: JSON.stringify({ branch: branch_name, mainBranch, merged: isMerged }) }] };
          } catch (error) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ branch: branch_name, error: error instanceof Error ? error.message : "Unknown error", merged: false }) }] };
          }
        }
      ),

      tool(
        "get_branch_info",
        "Get detailed information about a specific branch.",
        { branch_name: z.string().describe("The branch name to get info for") },
        async ({ branch_name }) => {
          try {
            const info = execGit(`git log -1 --format="%H|%an|%ae|%ci|%s" ${branch_name}`, repoPath);
            const [hash, author, email, date, message] = info.split("|");
            const lastCommitDate = new Date(date);
            const daysSinceLastCommit = Math.floor((Date.now() - lastCommitDate.getTime()) / (1000 * 60 * 60 * 24));
            return { content: [{ type: "text" as const, text: JSON.stringify({ branch: branch_name, lastCommit: { hash, author, email, date, message }, daysSinceLastCommit }) }] };
          } catch (error) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ branch: branch_name, error: error instanceof Error ? error.message : "Unknown error" }) }] };
          }
        }
      ),

      tool(
        "delete_local_branch",
        "Delete a local git branch. Use force=true for unmerged branches.",
        {
          branch_name: z.string().describe("The local branch name to delete"),
          force: z.boolean().optional().describe("Force delete even if not merged (default: false)"),
        },
        async ({ branch_name, force = false }) => {
          const currentBranch = execGit("git rev-parse --abbrev-ref HEAD", repoPath);
          if (currentBranch === branch_name) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Cannot delete the currently checked out branch" }) }] };
          }
          const flag = force ? "-D" : "-d";
          try {
            execGit(`git branch ${flag} ${branch_name}`, repoPath);
            return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Local branch '${branch_name}' deleted successfully` }) }] };
          } catch (error) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }) }] };
          }
        }
      ),

      tool(
        "delete_remote_branch",
        "Delete a remote git branch.",
        {
          branch_name: z.string().describe("The remote branch name to delete (without origin/ prefix)"),
          remote: z.string().optional().describe("The remote name (default: origin)"),
        },
        async ({ branch_name, remote = "origin" }) => {
          const cleanBranchName = branch_name.replace(new RegExp(`^${remote}/`), "");
          try {
            execGit(`git push ${remote} --delete ${cleanBranchName}`, repoPath);
            return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Remote branch '${remote}/${cleanBranchName}' deleted successfully` }) }] };
          } catch (error) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }) }] };
          }
        }
      ),

      tool(
        "ask_confirmation",
        "Ask the user for confirmation before performing a destructive action like deleting branches. MUST be used before any delete operations.",
        {
          message: z.string().describe("The confirmation message to display to the user"),
          branches_to_delete: z.array(z.string()).describe("List of branch names that will be deleted"),
        },
        async ({ message, branches_to_delete }) => {
          const confirmed = await askUserConfirmation(message, branches_to_delete);
          return { content: [{ type: "text" as const, text: JSON.stringify({ confirmed, message: confirmed ? "User approved the deletion" : "User cancelled the operation" }) }] };
        }
      ),

      tool("get_current_branch", "Get the name of the currently checked out branch.", {}, async () => {
        const currentBranch = execGit("git rev-parse --abbrev-ref HEAD", repoPath);
        return { content: [{ type: "text" as const, text: JSON.stringify({ currentBranch }) }] };
      }),

      tool("get_main_branch", "Detect the main branch name (main or master) for this repository.", {}, async () => {
        let mainBranch = "main";
        try {
          execGit("git rev-parse --verify main", repoPath);
        } catch {
          try {
            execGit("git rev-parse --verify master", repoPath);
            mainBranch = "master";
          } catch {
            try {
              const remoteHead = execGit("git symbolic-ref refs/remotes/origin/HEAD", repoPath);
              mainBranch = remoteHead.replace("refs/remotes/origin/", "");
            } catch {
              mainBranch = "main";
            }
          }
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({ mainBranch }) }] };
      }),
    ],
  });
}

// Process and display messages from the agent
function processMessage(message: Record<string, unknown>): boolean {
  logVerbose("[DEBUG]", colors.gray, `Message type: ${message.type}`);

  switch (message.type) {
    case "system": {
      const sysMsg = message as { type: "system"; subtype?: string; [key: string]: unknown };
      if (sysMsg.subtype === "init") {
        log("[SYSTEM]", colors.cyan, "Agent initialized");
        logVerbose("[SYSTEM]", colors.cyan, `  Model: ${sysMsg.model}`);
        logVerbose("[SYSTEM]", colors.cyan, `  CWD: ${sysMsg.cwd}`);
        logVerbose("[SYSTEM]", colors.cyan, `  Tools: ${(sysMsg.tools as string[])?.join(", ") || "none"}`);
      }
      break;
    }

    case "assistant": {
      logVerbose("[DEBUG]", colors.gray, `Assistant keys: ${Object.keys(message).join(", ")}`);

      // Handle message.message.content format
      if (message.message && typeof message.message === "object") {
        const msg = message.message as { content?: unknown };
        if (msg.content && Array.isArray(msg.content)) {
          for (const block of msg.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>) {
            if (block.type === "text" && block.text) {
              console.log(`\n${colors.green}${block.text}${colors.reset}`);
            } else if (block.type === "tool_use") {
              log("\n[TOOL CALL]", colors.yellow, `${block.name}`);
              if (verbose && block.input) {
                console.log(`${colors.dim}  Input: ${JSON.stringify(block.input, null, 2).split("\n").join("\n  ")}${colors.reset}`);
              }
            }
          }
        }
      }

      // Handle direct content array
      if (message.content && Array.isArray(message.content)) {
        for (const block of message.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>) {
          if (block.type === "text" && block.text) {
            console.log(`\n${colors.green}${block.text}${colors.reset}`);
          } else if (block.type === "tool_use") {
            log("\n[TOOL CALL]", colors.yellow, `${block.name}`);
            if (verbose && block.input) {
              console.log(`${colors.dim}  Input: ${JSON.stringify(block.input, null, 2).split("\n").join("\n  ")}${colors.reset}`);
            }
          }
        }
      }
      break;
    }

    case "user": {
      const userMsg = message as { content?: unknown };
      if (userMsg.content && Array.isArray(userMsg.content)) {
        for (const block of userMsg.content as Array<{ type: string; tool_use_id?: string }>) {
          if (block.type === "tool_result") {
            log("[TOOL RESULT]", colors.blue, `(id: ${block.tool_use_id?.slice(0, 8)}...)`);
          }
        }
      }
      break;
    }

    case "result": {
      const resultMsg = message as { subtype?: string; error?: string; duration_ms?: number; cost_usd?: number };
      if (resultMsg.subtype === "success") {
        log("\n[RESULT]", colors.green, "Turn completed");
      } else if (resultMsg.subtype === "error") {
        log("\n[RESULT]", colors.red, `Error: ${resultMsg.error || "Unknown error"}`);
        return false; // Signal error
      }
      if (resultMsg.duration_ms) {
        logVerbose("[STATS]", colors.gray, `Duration: ${(resultMsg.duration_ms / 1000).toFixed(1)}s`);
      }
      if (resultMsg.cost_usd !== undefined) {
        logVerbose("[STATS]", colors.gray, `Cost: $${resultMsg.cost_usd.toFixed(4)}`);
      }
      break;
    }
  }
  return true;
}

async function runAgent() {
  const args = parseArgs();
  const config = await loadConfig(args.configPath);

  const excludePatterns = [...config.excludePatterns, ...args.excludePatterns];
  const staleDays = args.staleDays ?? config.staleDays;
  const repoPath = args.repoPath ?? process.cwd();

  console.log("🧹 Git Branch Cleaner Agent (Interactive Mode)");
  console.log("=".repeat(50));
  console.log(`Repository: ${repoPath}`);
  console.log(`Stale threshold: ${staleDays} days`);
  if (excludePatterns.length > 0) {
    console.log(`Exclude patterns: ${excludePatterns.join(", ")}`);
  }
  console.log(`Verbose mode: ${verbose ? "ON" : "OFF (use -v for details)"}`);

  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  if (hasApiKey) {
    console.log(`Authentication: Using ANTHROPIC_API_KEY environment variable`);
  } else {
    console.log(`Authentication: Using Claude Code CLI credentials`);
  }
  console.log("=".repeat(50));
  console.log(`\n${colors.cyan}The agent will analyze your branches and ask for confirmation before deleting.${colors.reset}`);
  console.log(`${colors.cyan}After the analysis, you can type messages to interact with the agent.${colors.reset}`);
  console.log(`${colors.cyan}Type 'exit' or 'quit' to end the session.${colors.reset}\n`);

  const systemPrompt = `You are a Git Branch Cleaner agent. Your job is to help users clean up unnecessary git branches safely.

## Your Capabilities
You can:
1. List all local and remote branches
2. Check if branches are merged into the main branch
3. Check the last commit date of branches to identify stale ones
4. Delete local and remote branches (with user confirmation)

## Safety Rules
NEVER delete these protected branches:
- main, master
- dev, develop, development
- stage, staging
- prod, production
- preview
- release

Additionally, the user has configured these exclusion patterns:
${excludePatterns.length > 0 ? excludePatterns.map((p) => `- ${p}`).join("\n") : "- (none)"}

Any branch matching these patterns (glob-style matching) should NOT be deleted.

## Workflow
1. First, list all branches and gather information about each one (merged status, last commit date)
2. Analyze which branches are candidates for deletion based on:
   - Merged into main/master (safe to delete)
   - Stale (no commits in the last ${staleDays} days)
   - Branch name patterns suggesting temporary work (feature/, fix/, hotfix/, bugfix/, etc.)
3. Present your findings to the user with a summary
4. IMPORTANT: Immediately use the ask_confirmation tool with your recommended list of branches to delete
   - Do NOT ask the user what approach they prefer
   - Do NOT end the turn without calling ask_confirmation
   - The ask_confirmation tool will display the list to the user and get their yes/no response
5. Only proceed with deletion after the user confirms via the ask_confirmation tool
6. After deletion (or if user cancels), wait for further user instructions

## Working Directory
You are working in: ${repoPath}

## Important
- Always be cautious and err on the side of NOT deleting
- If unsure about a branch, ask the user
- Remote branches require separate deletion from local branches
- Use force delete (-D) only for unmerged branches after user confirms
- ALWAYS use ask_confirmation tool before any deletion - this is MANDATORY
- After completing an action, ask if the user wants to do anything else
- When you have a list of branches to recommend for deletion, call ask_confirmation immediately - don't ask the user to choose an approach first`;

  const mcpServer = createBranchCleanerMcpServer(repoPath);

  log("[INFO]", colors.cyan, "Starting agent...\n");

  const initialPrompt = `${systemPrompt}

---

Please analyze my git branches and help me clean up unnecessary ones.

Start by listing all branches and checking their merged status and last commit dates. Then provide a summary and use the ask_confirmation tool to ask for my approval before deleting anything.`;

  const queryOptions = {
    mcpServers: {
      "git-branch-cleaner": mcpServer,
    },
    model: "claude-sonnet-4-5-20250929" as const,
    allowedTools: [
      "mcp__git-branch-cleaner__list_branches",
      "mcp__git-branch-cleaner__check_merged_status",
      "mcp__git-branch-cleaner__get_branch_info",
      "mcp__git-branch-cleaner__get_current_branch",
      "mcp__git-branch-cleaner__get_main_branch",
      "mcp__git-branch-cleaner__ask_confirmation",
      "mcp__git-branch-cleaner__delete_local_branch",
      "mcp__git-branch-cleaner__delete_remote_branch",
    ],
    tools: [],
    cwd: repoPath,
  };

  // Run the conversation loop
  let currentPrompt = initialPrompt;
  let continueConversation = true;

  while (continueConversation) {
    // Start a query turn
    const q = query({
      prompt: currentPrompt,
      options: queryOptions,
    });

    // Process all messages from this turn
    for await (const message of q) {
      const ok = processMessage(message as Record<string, unknown>);
      if (!ok) {
        continueConversation = false;
        break;
      }
    }

    if (!continueConversation) break;

    // After the turn completes, ask for follow-up input
    console.log();
    const userInput = await promptUser("[YOU]>");

    if (!userInput || userInput.toLowerCase() === "exit" || userInput.toLowerCase() === "quit") {
      log("[INFO]", colors.cyan, "Ending session...");
      continueConversation = false;
    } else {
      // Continue conversation with the new prompt
      currentPrompt = userInput;
    }
  }

  console.log("\n✅ Branch cleanup session complete!");
}

runAgent().catch((error) => {
  console.error("Error running agent:", error);
  process.exit(1);
});
