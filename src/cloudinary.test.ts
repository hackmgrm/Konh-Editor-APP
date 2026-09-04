import assert from 'node:assert/strict';
import test from 'node:test';
import { articleLocalImages, replaceArticleImages } from './cloudinary.ts';

const images = { 'images/a.png': 'data:image/png;base64,AA==', 'other/b.jpg': 'data:image/jpeg;base64,AA==' };

test('finds local images referenced by both supported markdown forms', () => {
  assert.deepEqual(articleLocalImages('![[a.png]]\n![B](other/b.jpg)\n![R](https://x/y.png)', images), ['images/a.png', 'other/b.jpg']);
});

test('replaces only successfully uploaded local references', () => {
  const result = replaceArticleImages('![[a.png]]\n![B](other/b.jpg)', { 'images/a.png': 'https://cdn/a.png' });
  assert.equal(result, '![a.png](https://cdn/a.png)\n![B](other/b.jpg)');
});
