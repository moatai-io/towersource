import {it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({start:vi.fn(),attest:vi.fn(),verifyReceiver:vi.fn(),contractFor:vi.fn()}));
vi.mock('./central-issuer-service.js',()=>({startCentralIssuerService:m.start}));vi.mock('./installed-central-attestation.js',()=>({installedCentralAttestation:()=>({attest:m.attest,verifyReceiver:m.verifyReceiver})}));vi.mock('./central-issuer-authority.js',()=>({fileCentralIssuerAuthority:()=>({contractFor:m.contractFor})}));
import {startInstalledCentralIssuerService} from './installed-central-issuer-service.js';
it('startup receives concrete verifier and resolves receiver contract from published approval',async()=>{
 m.contractFor.mockResolvedValue({fixture:'contract'});await startInstalledCentralIssuerService({port:19001,serviceToken:'fixture-'.repeat(8),management:{baseUrl:'http://127.0.0.1:1',masterKey:'fixture-'.repeat(8)},preflight:async()=>{},selectionFile:'/etc/tower/selection.json',authority:{approvalDirectory:'/etc/tower/approvals',intentDirectory:'/var/lib/tower/intents'}});
 const config=m.start.mock.calls[0][0];expect(config.authority.attest).toBe(m.attest);const input={approvalHash:'fixture',providerKind:'litellm'},receiver={baseUrl:'https://fixture.example/'};await config.authority.verifyReceiver(input,receiver);expect(m.contractFor).toHaveBeenCalledWith('fixture','litellm');expect(m.verifyReceiver).toHaveBeenCalledWith({fixture:'contract'},input,receiver);
});
