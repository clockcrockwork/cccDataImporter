import Parser from 'rss-parser';
const parser = new Parser();

export async function getPopularProducts() {
  const response = await parser.parseURL('https://rsshub.app/producthunt/daily');
  return response.items.map(item => ({
    title: item.title,
    url: item.link,
    description: item.contentSnippet,
    image: item.enclosure.url,
    author: item.creator
  }));
}
