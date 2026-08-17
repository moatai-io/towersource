import remarkGfm from 'remark-gfm';

export const remarkGfmPlugin = [remarkGfm, { singleTilde: false }] as [typeof remarkGfm, { singleTilde: false }];
