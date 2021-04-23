const fs = require('fs');
const util = require('util');
const core = require('@actions/core');
const request = util.promisify(require('request'));
const { Octokit } = require('@octokit/action');

const MILLISECONDS_IN_MINUTE = 60000;
const GITHUB_SLACK_USER_LOOKUP = JSON.parse(
  core.getInput('gitHubSlackUserLookup')
);

const fetchReleaseForEvent = async event => {
  if (event.deployment_status) {
    const octokit = new Octokit();

    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    const { data } = await octokit.request(
      'GET /repos/:owner/:repo/releases/tags/:tag',
      {
        owner,
        repo,
        tag: event.deployment.ref,
      }
    );

    return data;
  }

  return event.release;
};

const fetchNewContributors = async () => {
  const release = await fetchReleaseForEvent(
    JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  );

  if (!release) {
    return {};
  }

  return release.body.match(/\@[\w]+/g).reduce(
    (contributors, contributor) => ({
      ...contributors,
      [contributor]:
        Date.now() +
        core.getInput('contributorOnCallDuration') *
          MILLISECONDS_IN_MINUTE,
    }),
    {}
  );
};

const fetchMonitors = async () => {
  const response = await request({
    method: 'GET',
    url: `https://api.datadoghq.com/api/v1/monitor?monitor_tags=${core.getInput(
      'datadogMonitorTag'
    )}`,
    headers: {
      'DD-API-KEY': core.getInput('datadogApiKey'),
      'DD-APPLICATION-KEY': core.getInput('datadogAppKey'),
    },
    json: true,
  });

  return response.body.map(monitor => {
    const [description, contributors] = monitor.message
      .split('---')
      .map(s => s.trim());

    return {
      id: monitor.id,
      name: monitor.name,
      description,
      contributors: JSON.parse(contributors || '{}'),
    };
  });
};

const updateMonitor = async monitor => {
  const mentions = Object.keys(monitor.contributors)
    .map(contributor =>
      GITHUB_SLACK_USER_LOOKUP[contributor]
        ? `<@${GITHUB_SLACK_USER_LOOKUP[contributor]}>`
        : ''
    )
    .join(' ');

  const message = `${monitor.description}\n\n---\n\n${JSON.stringify(
    monitor.contributors
  )}\n\n---\n\n${core.getInput('alertSlackChannel')} ${mentions}`;

  await request({
    method: 'PUT',
    url: `https://api.datadoghq.com/api/v1/monitor/${monitor.id}`,
    headers: {
      'Content-Type': 'application/json',
      'DD-API-KEY': core.getInput('datadogApiKey'),
      'DD-APPLICATION-KEY': core.getInput('datadogAppKey'),
    },
    body: JSON.stringify({ message }),
  });
};

const filterExpiredContributors = contributors =>
  Object.keys(contributors).reduce(
    (nc, c) =>
      contributors[c] > Date.now()
        ? {
            ...nc,
            [c]: contributors[c],
          }
        : nc,
    {}
  );

async function run() {
  try {
    const newContributors = await fetchNewContributors();

    for (const monitor of await fetchMonitors()) {
      const contributors = {
        ...filterExpiredContributors(monitor.contributors),
        ...newContributors,
      };

      await updateMonitor({
        ...monitor,
        contributors,
      });

      core.info(`Updated monitor '[${monitor.id}] ${monitor.name}'`);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
