# The merge check in CI

`ci_check.js` runs on a pull request from a `ticket/<ID>` branch and passes only when:

1. the branch carries `.agents/attestations/<ID>.bundle.json`, signed by a key listed in the
   **base** branch's `.agents/ticket-loop.trust`;
2. the bundle attests the pull request's exact head — one later commit that adds only the bundle
   is allowed, anything else is a change the run never saw;
3. the run's verdict was `APPROVE` or `APPROVE_WITH_COMMENTS` and its integrity check was intact;
4. the **base** branch's `verify.analyze` and `verify.test` pass when CI runs them itself.

It exits 0 to pass and 2 to block. Make the job a **required status check** in branch protection;
without that the platform lets a pull request merge around it, and nothing in this harness can
stop that.

## One-time setup

1. **Trusted keys.** Each developer who runs the loop runs `ledger.js keygen` once and sends the
   key id it prints. Commit the ids to `.agents/ticket-loop.trust` on the default branch, one per
   line, `#` for comments. Adding a key is then a reviewed change on the base branch; a pull
   request that edits the file does not change what its own check trusts.
2. **A CI key (recommended).** Generate one on a machine you trust, outside any repo:

   ```
   TICKET_LOOP_SIGNING_KEY=./ci-key.pem node <harness>/plugins/ticket-loop/skills/ticket-loop/scripts/ledger.js keygen
   ```

   Store the contents of `ci-key.pem` as a masked CI secret named `TICKET_LOOP_CI_KEY` and delete
   the file. With it, the check countersigns what it ran into `ci-attestation.json`, a claim the
   developer's machine could not have made. Publish its key id for auditors.
3. **The toolchain.** The job reruns your tests, so its image needs your stack: a Flutter image for
   Flutter, Node for Node, and so on. The examples use `node:20`; swap in your own and make sure
   `node` is on it.
4. **The harness.** CI does not have the plugin installed. Each job below fetches the harness at a
   pinned commit; replace `<harness-commit>` with the commit you reviewed, and bump it on purpose.

Developers commit the bundle at the end of a run; the playbook does this after `ledger.js close`.

## GitHub Actions

`.github/workflows/ticket-loop.yml`:

```yaml
name: ticket-loop merge check
on: pull_request
jobs:
  merge-check:
    if: startsWith(github.head_ref, 'ticket/')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Fetch the harness
        run: |
          git init -q /tmp/tlh
          git -C /tmp/tlh fetch -q --depth 1 https://github.com/SyedMuhammadRehan/ticket-loop-harness.git <harness-commit>
          git -C /tmp/tlh checkout -q FETCH_HEAD
      - name: Merge check
        env:
          TICKET_LOOP_CI_KEY: ${{ secrets.TICKET_LOOP_CI_KEY }}
        run: |
          if [ -n "$TICKET_LOOP_CI_KEY" ]; then printf '%s\n' "$TICKET_LOOP_CI_KEY" > /tmp/ci.pem; export TICKET_LOOP_SIGNING_KEY=/tmp/ci.pem; fi
          node /tmp/tlh/plugins/ticket-loop/skills/ticket-loop/scripts/ci_check.js --base "origin/${{ github.base_ref }}" --out ci-attestation.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ci-attestation
          path: ci-attestation.json
          if-no-files-found: ignore
```

## GitLab CI

In `.gitlab-ci.yml`:

```yaml
ticket-loop-merge-check:
  image: node:20
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^ticket\//'
  variables:
    GIT_DEPTH: 0
  script:
    - git fetch -q origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - git init -q /tmp/tlh
    - git -C /tmp/tlh fetch -q --depth 1 https://github.com/SyedMuhammadRehan/ticket-loop-harness.git <harness-commit>
    - git -C /tmp/tlh checkout -q FETCH_HEAD
    - if [ -n "$TICKET_LOOP_CI_KEY" ]; then printf '%s\n' "$TICKET_LOOP_CI_KEY" > /tmp/ci.pem; export TICKET_LOOP_SIGNING_KEY=/tmp/ci.pem; fi
    - node /tmp/tlh/plugins/ticket-loop/skills/ticket-loop/scripts/ci_check.js --base "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" --out ci-attestation.json
  artifacts:
    when: always
    paths:
      - ci-attestation.json
```

Then require the pipeline to succeed under *Settings → Merge requests*.

## Bitbucket Pipelines

In `bitbucket-pipelines.yml`:

```yaml
pipelines:
  pull-requests:
    'ticket/**':
      - step:
          name: ticket-loop merge check
          image: node:20
          clone:
            depth: full
          script:
            - git fetch -q origin "$BITBUCKET_PR_DESTINATION_BRANCH"
            - git init -q /tmp/tlh
            - git -C /tmp/tlh fetch -q --depth 1 https://github.com/SyedMuhammadRehan/ticket-loop-harness.git <harness-commit>
            - git -C /tmp/tlh checkout -q FETCH_HEAD
            - if [ -n "$TICKET_LOOP_CI_KEY" ]; then printf '%s\n' "$TICKET_LOOP_CI_KEY" > /tmp/ci.pem; export TICKET_LOOP_SIGNING_KEY=/tmp/ci.pem; fi
            - node /tmp/tlh/plugins/ticket-loop/skills/ticket-loop/scripts/ci_check.js --base "origin/$BITBUCKET_PR_DESTINATION_BRANCH" --out ci-attestation.json
          artifacts:
            - ci-attestation.json
```

Then add the check under *Repository settings → Branch restrictions → Merge checks* and require
a passing build.

## What the check does not prove

The rerun proves the tests pass at the merged head, by CI's own hand. The QA verdict, the stage
receipts and the criteria results inside the bundle are still the word of the machine that signed
it: CI verifies that they were not changed after signing and that the run passed by its own
record, not that the judgement was right. Review the pull request as you would any other.
