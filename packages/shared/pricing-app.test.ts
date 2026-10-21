import {describe,it,expect} from 'vitest';
import {parsePricingDeclaration,parsePricingValues,calculatePricing} from './pricing-app';
const values={customers:100,price:50000,discount:10,fixed:2000000,variable:10000};
describe('host pricing contract',()=>{
 it('computes exact totals',()=>expect(calculatePricing(values)).toEqual({revenue:4500000,cost:3000000,contribution:1500000,breakEvenCustomers:58}));
 it('has no break-even with nonpositive unit margin',()=>expect(calculatePricing({...values,discount:100}).breakEvenCustomers).toBeNull());
 it.each([NaN,Infinity,-1,1.5,1000001])('rejects invalid customers %s',customers=>expect(()=>parsePricingValues({...values,customers})).toThrow());
 it('rejects unknown executable declarations',()=>expect(()=>parsePricingDeclaration({schemaVersion:1,template:'pricing.v1',initialValues:values,script:'alert(1)'})).toThrow());
 it('rejects extra value fields',()=>expect(()=>parsePricingValues({...values,url:'https://example.com'})).toThrow());
 it('bounds large totals within safe integer range',()=>expect(Number.isSafeInteger(calculatePricing({customers:1000000,price:1000000000,discount:0,fixed:1000000000,variable:1000000000}).cost)).toBe(true));
});
