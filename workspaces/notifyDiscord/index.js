import fetch from 'node-fetch';

export async function postToDiscord(webhookUrl, content) {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(content)
  });
}

export async function notifyGithubRepos(webhookUrl, repos) {
  for (const repo of repos) {
    const content = {
      embeds: [{
        title: repo.title,
        url: repo.url,
        description: repo.description,
        thumbnail: { url: repo.image }
      }]
    };
    await postToDiscord(webhookUrl, content);
  }
}

export async function notifyProductHunt(webhookUrl, products) {
  for (const product of products) {
    const content = {
      embeds: [{
        title: product.title,
        url: product.url,
        description: product.description,
        thumbnail: { url: product.image },
        footer: { text: `Posted by ${product.author}` }
      }]
    };
    await postToDiscord(webhookUrl, content);
  }
}
