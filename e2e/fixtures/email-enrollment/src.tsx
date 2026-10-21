import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../packages/frontend/src/i18n';
import '../../../packages/frontend/src/index.css';
import { LoginPage } from '../../../packages/frontend/src/components/auth/LoginPage';
function Fixture() {
  const [challenge,setChallenge] = useState<any>(null);
  const [error,setError] = useState('');
  const [done,setDone] = useState(false);
  return done ? <p>Fixture login completed</p> : <LoginPage isSetup={false} error={error} emailEnrollment={challenge}
    onLogin={async()=>{setChallenge({challengeId:'draft',emailRequired:true,maskedEmail:'',resendAvailableAt:''});}}
    onEmailEnrollmentAction={async(action,value)=>{
      setError('');
      if(action==='cancel'){setChallenge(null);return true;}
      if(action==='verify'){
        if(value!=='123456'){setError('Invalid OTP');return false;}
        setDone(true);return true;
      }
      setChallenge({challengeId:action+Date.now(),emailRequired:false,maskedEmail:'u***@example.com',resendAvailableAt:new Date(Date.now()+60000).toISOString()});return true;
    }} />;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
