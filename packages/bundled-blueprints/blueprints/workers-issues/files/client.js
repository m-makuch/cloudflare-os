document.body.style.cssText = 'font:16px system-ui;padding:24px;max-width:960px;margin:auto';
const heading = document.createElement('h1');
heading.textContent = 'Worker issue inbox';
const description = document.createElement('p');
description.textContent = 'Investigations use read-only telemetry for the connected Worker. Repository access, project tests, code changes, and deployments require separate capabilities.';
const refresh = document.createElement('button');
refresh.textContent = 'Refresh investigations';
const status = document.createElement('p');
status.setAttribute('role', 'status');
const investigations = document.createElement('section');
investigations.setAttribute('aria-label', 'Investigations');
document.body.replaceChildren(heading, description, refresh, status, investigations);

async function render() {
  if (refresh.disabled) return;
  refresh.disabled = true;
  try {
    const [runs, setup] = await Promise.all([gadget.listInvestigations(), gadget.getSetupStatus()]);
    status.textContent = `${setup.investigationsEnabled ? 'AI investigations enabled.' : 'AI investigations are off; notifications are stored without running a model.'} ${runs.length ? `${runs.length} notification(s).` : 'Waiting for an issue notification. Save your automation in the dashboard to connect delivery.'}`;
    investigations.replaceChildren(...runs.map(run => {
      const article = document.createElement('article');
      const title = document.createElement('h2');
      title.textContent = run.issue_id;
      const progress = document.createElement('p');
      progress.textContent = `${new Date(run.created_at).toLocaleString()} · ${run.status.replaceAll('_', ' ')}`;
      const report = document.createElement('pre');
      report.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
      report.textContent = run.report || (run.status === 'received'
        ? 'Notification received. AI investigations were not enabled; no model was run.'
        : run.status === 'delivery_unknown'
        ? 'Delivery could not be confirmed. Check the workspace conversations before sending again.'
        : 'The investigator has not submitted a report yet.');
      article.append(title, progress, report);
      return article;
    }));
  } catch {
    status.textContent = 'Could not load investigations. Refresh to try again.';
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener('click', render);
const timer = setInterval(render, 5000);
window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
void render();
