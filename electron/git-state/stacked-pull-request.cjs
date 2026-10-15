// @ts-check

/**
 * Stack descriptions repeat the incremental review link above the stack and
 * next to the current entry. Match the repository and PR number, never the
 * position of an entry or the branch's display name.
 *
 * @param {string | null | undefined} body
 * @param {{number: number; owner: string; repo: string}} pullRequest
 * @returns {{base: string; head: string} | undefined}
 */
const parseStackedPullRequestRange = (body, pullRequest) => {
  /** @type {{base: string; head: string} | undefined} */
  let range;
  for (const match of (body || '').matchAll(/https:\/\/(?:www\.)?github\.com\/[^\s<>"\])]+/gi)) {
    const url = new URL(match[0]);
    const path = url.pathname.match(
      /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/files\/([a-f\d]{40})\.\.([a-f\d]{40})\/?$/i,
    );
    if (
      !path ||
      path[1].toLowerCase() !== pullRequest.owner.toLowerCase() ||
      path[2].toLowerCase() !== pullRequest.repo.toLowerCase() ||
      path[3] !== String(pullRequest.number)
    ) {
      continue;
    }

    const candidate = { base: path[4].toLowerCase(), head: path[5].toLowerCase() };
    if (range && (range.base !== candidate.base || range.head !== candidate.head)) {
      throw new Error(
        `PR ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number} has conflicting stacked commit ranges in its description. Update its incremental review links and retry.`,
      );
    }
    range = candidate;
  }
  return range;
};

module.exports = { parseStackedPullRequestRange };
