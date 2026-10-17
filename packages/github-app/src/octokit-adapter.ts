import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { GitHubAppConfig } from "./config.js";
import { toSafeGitHubApiError } from "./errors.js";
import type { GitHubApiFactory, GitHubRepositoryApi } from "./model.js";

const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

/** Creates installation-authenticated Octokit clients scoped to one repository. */
export class OctokitGitHubApiFactory implements GitHubApiFactory {
  constructor(private readonly config: Pick<GitHubAppConfig, "appId" | "privateKey">) {}

  forInstallation(input: { installationId: number; repositoryId: number }): GitHubRepositoryApi {
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.appId,
        privateKey: this.config.privateKey,
        installationId: input.installationId,
        repositoryIds: [input.repositoryId],
        permissions: { checks: "write", pull_requests: "read" },
      },
      request: { timeout: GITHUB_REQUEST_TIMEOUT_MS },
    });

    return {
      async getPullRequest(request) {
        try {
          const response = await octokit.rest.pulls.get({
            owner: request.owner,
            repo: request.repositoryName,
            pull_number: request.pullRequestNumber,
          });
          return {
            headSha: response.data.head.sha,
            baseRepositoryId: response.data.base.repo.id,
          };
        } catch (error) {
          throw toSafeGitHubApiError("pulls.get", error);
        }
      },

      async createCheckRun(request) {
        try {
          const response = await octokit.rest.checks.create({
            owner: request.owner,
            repo: request.repositoryName,
            name: request.name,
            head_sha: request.headSha,
            status: request.status,
            started_at: request.startedAt,
            external_id: request.externalId,
          });
          return { id: response.data.id };
        } catch (error) {
          throw toSafeGitHubApiError("checks.create", error);
        }
      },

      async completeCheckRun(request) {
        try {
          await octokit.rest.checks.update({
            owner: request.owner,
            repo: request.repositoryName,
            check_run_id: request.checkRunId,
            status: request.status,
            conclusion: request.conclusion,
            completed_at: request.completedAt,
            output: {
              title: request.title,
              summary: request.summary,
            },
          });
        } catch (error) {
          throw toSafeGitHubApiError("checks.update", error);
        }
      },
    };
  }
}
