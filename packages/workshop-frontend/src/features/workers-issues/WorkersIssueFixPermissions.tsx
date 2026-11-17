import { Check, X } from "@phosphor-icons/react";
import { FIX_BRANCH_PREFIX } from "./contributorRepository";

const permissions = [
  { allowed: true, text: "Commit a fix and a regression test" },
  {
    allowed: true,
    text: "Push to new branches starting with",
    branchPrefix: FIX_BRANCH_PREFIX,
  },
  { allowed: true, text: "Open pull or merge requests into the default branch" },
  { allowed: false, text: "Merge pull or merge requests" },
  { allowed: false, text: "Push to the default branch, protected branches, or other branch names" },
  { allowed: false, text: "Deploy the Worker" },
];

export const WorkersIssueFixPermissions = () => (
  <div className="grid gap-4 text-sm text-kumo-subtle">
    <p className="font-medium text-kumo-default">Your fixer can/cannot do:</p>
    <ul aria-label="Fixer permissions" className="grid gap-2">
      {permissions.map(({ allowed, text, branchPrefix }) => {
        const Icon = allowed ? Check : X;
        return (
          <li key={text} className="flex items-start gap-2">
            <Icon
              aria-hidden="true"
              size={16}
              weight="bold"
              className="mt-0.5 shrink-0 text-kumo-default"
            />
            <span>
              <span className="sr-only">{allowed ? "Can: " : "Cannot: "}</span>
              {text}
              {branchPrefix && (
                <>
                  {" "}
                  <code>{branchPrefix}</code>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
    <p>
      Enabling fixes approves these pushes and requests without asking again. You review and merge;
      your CI deploys.
    </p>
    <div className="grid gap-1">
      <p className="font-medium text-kumo-default">Prompt injection warning</p>
      <p>
        Production logs and issue notifications can contain malicious instructions or sensitive
        data. The fixer is instructed to ignore those instructions and keep sensitive data out of
        proposed changes, but it can make mistakes. Review every change before merging.
      </p>
    </div>
  </div>
);
