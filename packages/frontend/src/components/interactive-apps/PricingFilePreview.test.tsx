// @vitest-environment jsdom
import React from 'react';
import {afterEach,it,expect} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import {PricingFilePreview,isPricingAppFile} from './PricingFilePreview';
afterEach(cleanup);
it('only opts in explicit filenames',()=>{expect(isPricingAppFile('report.json')).toBe(false);expect(isPricingAppFile('demo.pricing-app.json')).toBe(true)});
it('rejects malformed JSON',()=>{render(<PricingFilePreview content="{"/>);expect(screen.getByRole('alert')).toBeTruthy()});
it('shows calculation without claiming session delivery',()=>{render(<PricingFilePreview content={JSON.stringify({schemaVersion:1,template:'pricing.v1',initialValues:{customers:100,price:50000,discount:10,fixed:2000000,variable:10000}})}/>);expect(screen.getByText('4,500,000원')).toBeTruthy();expect((screen.getByText('조건 검토') as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText(/전송은 아직 연결되지/)).toBeTruthy()});
