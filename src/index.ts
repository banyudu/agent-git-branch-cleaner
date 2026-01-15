#!/usr/bin/env node

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execSync } from "child_process";
import * as readline from "readline";
import { parseArgs } from "./cli.js";
import { loadConfig } from "./config.js";

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

// Helper to ask user for confirmation
async function askUserConfirmation(message: string, branches: string[]): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n" + "=".repeat(50));
  console.log("⚠️  CONFIRMATION REQUIRED");
  console.log("=".repeat(50));
  console.log(message);
  console.log("\nBranches to be deleted:");
  branches.forEach((b) => console.log(`  - ${b}`));
  console.log();

  return new Promise((resolve) => {
    rl.question("Do you want to proceed? (yes/no): ", (answer) => {
      rl.close();
      const confirmed = answer.toLowerCase() === "yes" || answer.toLowerCase() === "y";
      console.log(confirmed ? "✅ Confirmed" : "❌ Cancelled");
      resolve(confirmed);
    });
  });
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
                  branches.push({
                    name,
                    type: "local",
                    lastCommitDate: date,
                    commitHash: hash,
                  });
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
                  branches.push({
                    name,
                    type: "remote",
                    lastCommitDate: date,
                    commitHash: hash,
                  });
                }
              }
            }
          }

          return { content: [{ type: "text" as const, text: JSON.stringify(branches, null, 2) }] };
        }
      ),

      tool(
        "check_merged_status",
        "Check if a branch has been merged into the main/master branch. Returns true if merged, false otherwise.",
        {
          branch_name: z.string().describe("The branch name to check"),
        },
        async ({ branch_name }) => {
          let mainBranch = "main";
          try {
            execGit("git rev-parse --verify main", repoPath);
          } catch {
            try {
              execGit("git rev-parse --verify master", repoPath);
              mainBranch = "master";
            } catch {
              return {
                content: [{ type: "text" as const, text: JSON.stringify({ error: "Could not find main or master branch", merged: false }) }],
              };
            }
          }

          try {
            const mergedBranches = execGit(`git branch --merged ${mainBranch}`, repoPath);
            const isMerged = mergedBranches.split("\n").some((b) => b.trim().replace("* ", "") === branch_name);
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ branch: branch_name, mainBranch, merged: isMerged }) }],
            };
          } catch (error) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ branch: branch_name, error: error instanceof Error ? error.message : "Unknown error", merged: false }) }],
            };
          }
        }
      ),

      tool(
        "get_branch_info",
        "Get detailed information about a specific branch including last commit date, author, and commit message.",
        {
          branch_name: z.string().describe("The branch name to get info for"),
        },
        async ({ branch_name }) => {
          try {
            const info = execGit(
              `git log -1 --format="%H|%an|%ae|%ci|%s" ${branch_name}`,
              repoPath
            );
            const [hash, author, email, date, message] = info.split("|");

            const lastCommitDate = new Date(date);
            const now = new Date();
            const daysSinceLastCommit = Math.floor(
              (now.getTime() - lastCommitDate.getTime()) / (1000 * 60 * 60 * 24)
            );

            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  branch: branch_name,
                  lastCommit: { hash, author, email, date, message },
                  daysSinceLastCommit,
                }),
              }],
            };
          } catch (error) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ branch: branch_name, error: error instanceof Error ? error.message : "Unknown error" }) }],
            };
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
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Cannot delete the currently checked out branch" }) }],
            };
          }

          const flag = force ? "-D" : "-d";
          try {
            execGit(`git branch ${flag} ${branch_name}`, repoPath);
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Local branch '${branch_name}' deleted successfully` }) }],
            };
          } catch (error) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }) }],
            };
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
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: `Remote branch '${remote}/${cleanBranchName}' deleted successfully` }) }],
            };
          } catch (error) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }) }],
            };
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
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                confirmed,
                message: confirmed ? "User approved the deletion" : "User cancelled the operation",
              }),
            }],
          };
        }
      ),

      tool(
        "get_current_branch",
        "Get the name of the currently checked out branch.",
        {},
        async () => {
          const currentBranch = execGit("git rev-parse --abbrev-ref HEAD", repoPath);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ currentBranch }) }],
          };
        }
      ),

      tool(
        "get_main_branch",
        "Detect the main branch name (main or master) for this repository.",
        {},
        async () => {
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
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ mainBranch }) }],
          };
        }
      ),
    ],
  });
}

async function runAgent() {
  const args = parseArgs();
  const config = await loadConfig(args.configPath);

  const excludePatterns = [...config.excludePatterns, ...args.excludePatterns];
  const staleDays = args.staleDays ?? config.staleDays;
  const repoPath = args.repoPath ?? process.cwd();

  console.log("🧹 Git Branch Cleaner Agent");
  console.log("=".repeat(50));
  console.log(`Repository: ${repoPath}`);
  console.log(`Stale threshold: ${staleDays} days`);
  if (excludePatterns.length > 0) {
    console.log(`Exclude patterns: ${excludePatterns.join(", ")}`);
  }
  console.log("=".repeat(50));
  console.log();

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
3. Present your findings to the user with a summary table
4. Ask for confirmation using ask_confirmation tool before deleting any branches
5. Only delete branches after explicit user approval via ask_confirmation

## Working Directory
You are working in: ${repoPath}

## Important
- Always be cautious and err on the side of NOT deleting
- If unsure about a branch, ask the user
- Remote branches require separate deletion from local branches
- Use force delete (-D) only for unmerged branches after user confirms
- ALWAYS use ask_confirmation before any deletion`;

  const prompt = `Please analyze my git branches and help me clean up unnecessary ones.

Start by listing all branches and checking their merged status and last commit dates. Then provide a summary and ask for my confirmation before deleting anything.`;

  const mcpServer = createBranchCleanerMcpServer(repoPath);

  const q = query({
    prompt,
    options: {
      systemPrompt,
      mcpServers: {
        "git-branch-cleaner": mcpServer,
      },
      model: "claude-sonnet-4-5-20250929",
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
    },
  });

  for await (const message of q) {
    if (message.type === "assistant" && "content" in message) {
      const content = message.content as Array<{ type: string; text?: string }>;
      for (const block of content) {
        if (block.type === "text" && block.text) {
          console.log(block.text);
        }
      }
    }
  }

  console.log("\n✅ Branch cleanup session complete!");
}

runAgent().catch((error) => {
  console.error("Error running agent:", error);
  process.exit(1);
});
