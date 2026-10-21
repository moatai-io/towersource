// @vitest-environment jsdom
import React from 'react';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {PricingApp} from './PricingApp';
afterEach(cleanup);
const declaration={schemaVersion:1,template:'pricing.v1',initialValues:{customers:100,price:50000,discount:10,fixed:2000000,variable:10000}};
describe('host-owned pricing UI',()=>{
 it('requires review and confirmation',async()=>{const send=vi.fn().mockResolvedValue(undefined);render(<PricingApp declaration={declaration} onConfirm={send}/>);expect(send).not.toHaveBeenCalled();fireEvent.click(screen.getByText('조건 검토'));expect(send).not.toHaveBeenCalled();fireEvent.click(screen.getByText('확인 후 전달'));await waitFor(()=>expect(send).toHaveBeenCalledTimes(1));expect(send).toHaveBeenCalledWith(declaration.initialValues)});
 it('invalidates confirmation when inputs change',()=>{render(<PricingApp declaration={declaration} onConfirm={vi.fn()}/>);fireEvent.click(screen.getByText('조건 검토'));fireEvent.change(screen.getByLabelText('고객 수'),{target:{value:'42'}});expect(screen.queryByText('확인 후 전달')).toBeNull()});
 it('renders malicious titles as text',()=>{const title='<img src="https://example.com/leak">';const {container}=render(<PricingApp declaration={{...declaration,title}} onConfirm={vi.fn()}/>);expect(screen.getByText(title)).toBeTruthy();expect(container.querySelector('img')).toBeNull()});
 it('does not accept an executable declaration',()=>{render(<PricingApp declaration={{...declaration,script:'alert(1)'}} onConfirm={vi.fn()}/>);expect(screen.getByRole('alert').textContent).toContain('지원하지 않는')});
 it('locks duplicate clicks while submitting',async()=>{let finish!:()=>void;const send=vi.fn(()=>new Promise<void>(r=>{finish=r}));render(<PricingApp declaration={declaration} onConfirm={send}/>);fireEvent.click(screen.getByText('조건 검토'));const button=screen.getByText('확인 후 전달');fireEvent.click(button);fireEvent.click(button);expect(send).toHaveBeenCalledTimes(1);finish();await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('전달했습니다'))});
});
