// Catalog compatibility: older syncs classify T-shirts as "other".
export function isTshirt(product) {
  return ['t-shirt', 'tshirt'].includes(product?.product_type) ||
    /\bt[\s-]?shirt\b/i.test(product?.title || '');
}
export const SHIRT_MOCKUPS = { Ivory: 't1.png', Black: 't2.png', Grey: 't3.png', White: 't4.png' };
export function shirtVariants(variants = []) {
  const sizes = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
  return variants.map(v => {
    const parts = String(v.size || '').split('/').map(s => s.trim());
    const size = parts.find(p => sizes.includes(p)) || parts[0];
    const color = parts.find(p => Object.hasOwn(SHIRT_MOCKUPS, p));
    return { id: v.id, size, color, price: Number(v.price), detail: '' };
  }).filter(v => v.color && Number.isFinite(v.price) && v.price > 0)
    .sort((a, b) => sizes.indexOf(a.size) - sizes.indexOf(b.size));
}
export function shirtMockup(color = 'White') {
  return { file: SHIRT_MOCKUPS[color] || SHIRT_MOCKUPS.White, opening: 'top:27%;left:36%;width:28%;height:39%;object-fit:contain;' };
}
