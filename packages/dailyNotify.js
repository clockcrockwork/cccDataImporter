import { getPopularRepositories } from './getPopularRepositories';
import { getPopularProducts } from './getPopularProducts';
import { notifyGithubRepos, notifyProductHunt } from './notifyDiscord';

async function main() {
  try {
    const githubRepos = await getPopularRepositories();
    const productHuntProducts = await getPopularProducts();

    await notifyGithubRepos(process.env.GITHUB_WEBHOOK_URL, githubRepos);
    await notifyProductHunt(process.env.PRODUCT_HUNT_WEBHOOK_URL, productHuntProducts);

    console.log('Notification completed');
  } catch (error) {
    console.error('Error occurred:', error);
  }
}

main();
