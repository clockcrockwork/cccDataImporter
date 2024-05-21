import fetch from 'node-fetch';

export async function getPopularRepositories() {
  const response = await fetch('https://api.github.com/search/repositories?q=stars:>1&sort=stars&order=desc');
  const data = await response.json();

  return data.items.slice(0, 5).map(repo => ({
    title: repo.name,
    url: repo.html_url,
    description: repo.description,
    image: repo.owner.avatar_url
  }));
}
