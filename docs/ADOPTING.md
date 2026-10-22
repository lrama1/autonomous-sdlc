# Adopting Autonomous SDLC: a checklist for teams that copy this repository

Follow this top to bottom. Plan on one to two hours of work, plus about 20 minutes of waiting for the first deploy. The platform costs about $3.30 a day while it is up (roughly $100 a month), plus model fees for every agent run. [README.md](../README.md) has the details behind each step.

## 0. What you need before you start

- [ ] **An AWS account** where you have administrator rights. The one-time bootstrap creates IAM roles. The stack deploys to `us-east-1`.
- [ ] **A GitHub account or organization** for your copy of this repository and for the repositories the agents will work on. Protected branches and required reviews on _private_ repositories need GitHub Pro (personal account) or GitHub Team (organization).
- [ ] **An OpenRouter account and API key** for the agents' model calls. Give the key a daily credit limit.
- [ ] **A repository for the agents to work on.** It can be new and nearly empty (see step 8).
- [ ] **On one machine, once:** Git, Terraform 1.6 or later, and the AWS CLI signed in with administrator credentials. PowerShell 7 is optional, for the helper scripts.
- [ ] **Optional:** a domain in a Route 53 hosted zone, for names like `app.example.com` and `previews.example.com`. Without it the platform uses its CloudFront address.

## 1. Make your copy of this repository

- [ ] Use **"Use this template"** (or a private mirror) to make a **private** copy in your own account or organization. A fork of a public repository is always public, which is usually wrong for infrastructure code.
- [ ] In the copy, allow GitHub Actions (Settings → Actions).
- [ ] Nothing in the deploy code names the original owner, domain or AWS account. Those appear only in the architecture diagram, a comment in `infra/bootstrap/main.tf`, and tests. Your values come from the variables you set below.

## 2. Protect `main` in your copy

The deploy role is an AWS administrator, and **anyone who can push to `main` and run the workflow can administer your AWS account**. Do this before step 3.

- [ ] Settings → Rules → Rulesets: protect `main`. Require a pull request, require the `verify` status check, require at least one approving review, and allow no bypass.
- [ ] Keep the list of people with write access short.

## 3. Bootstrap AWS (once, by an AWS administrator)

- [ ] Read your copy's GitHub sign-in subject prefix. Run `gh api repos/OWNER/REPO/actions/oidc/customization/sub` and use the `sub_claim_prefix` it shows, for example `repo:OWNER@ID/REPO@ID`.
- [ ] Apply the bootstrap:

  ```bash
  cd infra/bootstrap
  terraform init
  terraform apply -var repository=repo:OWNER@ID/REPO@ID
  ```

- [ ] Write down the two outputs: `deploy_role_arn` and `state_bucket`.

This creates the Terraform state bucket and the `sdlc-github-deploy` role. Only your repository's workflows on `main` can assume it. No AWS keys are stored in GitHub.

## 4. Set the repository variables and secret

In your copy: Settings → Secrets and variables → Actions.

- [ ] Variable `AWS_DEPLOY_ROLE_ARN` = the bootstrap's `deploy_role_arn`
- [ ] Variable `TF_STATE_BUCKET` = the bootstrap's `state_bucket`
- [ ] Variable `BOOTSTRAP_ADMIN_EMAIL` = the email of the first person to sign in. They become the platform admin.
- [ ] Secret `OPENROUTER_KEY_AGENTS` = your OpenRouter key
- [ ] **Optional, only if you use your own domain, all three or none:** variables `APP_DOMAIN`, `PREVIEW_DOMAIN` (a different name from `APP_DOMAIN`) and `HOSTED_ZONE_ID`.

## 5. Deploy

- [ ] Actions → **deploy** → Run workflow, on `main`. Choose `action` = `deploy`. Turn `independent_review` off if one person will approve everything.
- [ ] Wait about 10 to 20 minutes (more with a custom domain, because of certificate validation). The run summary prints the platform address. The workflow waits for the platform to answer on `/readyz`.

## 6. Create sign-in users

People cannot sign themselves up. An admin creates each sign-in in Amazon Cognito. Find the user pool id in the AWS console (Cognito → User pools) or with `aws cognito-idp list-user-pools --max-results 10 --region us-east-1`.

- [ ] Create each person, with a password they can use at once:

  ```bash
  aws cognito-idp admin-create-user --region us-east-1 --user-pool-id POOL_ID \
    --username them@example.com \
    --user-attributes Name=email,Value=them@example.com Name=email_verified,Value=true \
    --message-action SUPPRESS
  aws cognito-idp admin-set-user-password --region us-east-1 --user-pool-id POOL_ID \
    --username them@example.com --password 'A-long-password-1' --permanent
  ```

  Passwords need 12 or more characters. If you have PowerShell and Terraform state access, `infra/aws/create-user.ps1 -Email … ` or `-UsersFile users.csv` does the same and generates passwords.

- [ ] Sign in at the platform address as the `BOOTSTRAP_ADMIN_EMAIL` person. They get the **Platform Admin** hat, which can make every decision. That is enough for a team of one.
- [ ] To give other people hats (`product_owner`, `architect`, `frontend_engineer`, `backend_engineer`, `qa`, `devops_release`, `security`), an admin calls the API. There is no page for it yet. While signed in as an admin, open the browser console on the platform and run:

  ```js
  // find the person's id
  await (await fetch('/api/people')).json();
  // give a hat
  await fetch('/api/people/PERSON_ID/hats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'product_owner' }),
  });
  ```

## 7. Register the two GitHub Apps

The platform acts on GitHub through two Apps: an **Agent App** (pushes branches, opens pull requests) and a **Gate App** (merges, and approves when a person has). The platform makes them for you.

- [ ] Signed in as the admin, open `<platform address>/admin/github`.
- [ ] Register the **Agent** App, then the **Gate** App. GitHub asks you to confirm each one, so be signed in to GitHub as the account that should own them.
- [ ] Install each App on **only the repositories the agents may use** ("Only select repositories"). The platform refuses an install on all repositories.
- [ ] Keep the private keys where they are. The platform stores them in AWS Secrets Manager.

## 8. Prepare the repository the agents will work on

This is a different repository from your copy of the platform.

- [ ] It has a script `npm run verify` that runs its checks and fails when something is wrong. Agents run it before every pull request, and CI runs it on every pull request. A new repository can start with `"verify": "node --test"` in `package.json`.
- [ ] It has a GitHub Actions workflow whose **job is named `verify`** and that runs `npm run verify` on pull requests. Agents cannot edit `.github/workflows/**`.
- [ ] Protect its `main` branch the way the platform expects: require the `verify` check (up to date with `main`), require **one approving review**, and dismiss stale approvals. The Gate App's approving review is what allows a merge.
- [ ] Install both Apps on this repository (step 7).

## 9. Register that repository in the platform

There is no page for this yet. While signed in as the admin, open the browser console on the platform and run:

```js
await fetch('/api/repositories', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fullName: 'OWNER/REPO' }),
}).then((r) => r.json());
```

- [ ] It answers with the new entry. If it says an App is not installed, check step 7.

## 10. Check that it works

- [ ] Open the **Map** tab, create an initiative on your repository with a one-sentence goal, and start the spec.
- [ ] When the spec arrives in the **Attention queue**, approve it. Then start the design, approve it, and start the build.
- [ ] Expect a few hard stops the first time. Agents that write `.sdlc/preview.yaml` stop at a protected path and ask you to allow it. That is by design.
- [ ] Look at the **Costs** tab after the first run, so you know what a run costs.

## Running costs and cleanup

- [ ] Idle cost is about $3.30 a day. To stop it, run the **deploy** workflow with `action` = `destroy` and type `destroy` in `confirm_destroy`. Redeploying later gives you a new Cognito pool, so repeat steps 6 and 7.
- [ ] To remove the bootstrap as well (state bucket and deploy role), run `terraform destroy` in `infra/bootstrap`.
- [ ] A cost alarm is not wired up yet. Set a budget in AWS Billing yourself.

## Know before you rely on it

- [SECURITY-REVIEW.md](../SECURITY-REVIEW.md) lists known weaknesses of the AWS deployment. Read it before you put sensitive code through the platform.
- Slack notifications are not wired up on AWS. Everything waits in the Attention queue.
- Agent runs cost real money. Previews and agent sandboxes are one-off Fargate tasks that stop on their own.
