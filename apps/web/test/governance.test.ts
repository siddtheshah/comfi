import assert from 'node:assert/strict'
import test from 'node:test'
import { PublicKey } from '@solana/web3.js'
import { createHash } from 'node:crypto'
import { buildGovernanceTransaction, decodeProposal, decodeVotingMember, decodeWithdrawal, encodeAction, fetchGovernance, parseUsdc, proposalEligibility, proposalKinds, requiredVotes, votingPower, type GovernanceSnapshot, type ProposalAction } from '../src/governance.ts'
import { poolFromAccount } from '../src/solana.ts'
import { creator, poolAddress, poolBytes } from './fixtures/pool.ts'
import { memberAddress, programId, proposalAddress, proposalBytes, memberBytes, withdrawalBytes } from './fixtures/governance.ts'

function snapshot(): GovernanceSnapshot {
  const pool = poolFromAccount(poolAddress,poolBytes({ locked:false }).toString('base64'),'100000000')
  pool.voteThreshold=5001;pool.metrics!.fundedMemberCount=3;pool.metrics!.votingMemberCount=3
  return { pool, now:1_790_000_000n, members:[decodeVotingMember(memberAddress,memberBytes())],proposals:[decodeProposal(proposalAddress,proposalBytes())], withdrawals:[], receipts:[] }
}
for (const [tag, kind] of proposalKinds.entries()) test(`decodes ${kind} in independent Rust field order`, () => {
  const p=decodeProposal(proposalAddress,proposalBytes(tag))
  assert.equal(p.action.kind,kind);assert.equal(p.yesVotes,2);assert.equal(p.votingCycle,9n);assert.equal(p.deadlineCycle,10n);assert.equal(p.executableCycle,11n);assert.equal(p.executionMode,'on_deadline');assert.equal(p.voteThreshold,5001)
  if(p.action.kind==='SetSpenderLimit')assert.equal(p.action.cap,9_007_199_254_740_993n)
  if(p.action.kind==='ConfigurationModification')assert.equal(p.action.withdrawalExecutionMode,'threshold_met')
  const bytes=proposalBytes(tag);assert.throws(()=>decodeProposal(proposalAddress,bytes.subarray(0,bytes.length-1)),/Truncated/)
  const corrupted=Buffer.from(bytes);corrupted[80]=255;assert.throws(()=>decodeProposal(proposalAddress,corrupted),/Invalid governance enum/)
})
for(const next of [false,true])for(const vouch of [false,true])test(`member optional pointers ${next}/${vouch}`,()=>{
  const m=decodeVotingMember(memberAddress,memberBytes({next,vouch}));assert.equal(m.status,'Active');assert.equal(m.fundedCycleStreak,3n);assert.equal(m.totalContributions,27_000_000n);assert.equal(m.isMaturedVoter,true);assert.equal(m.nextMember,next?proposalAddress:null)
  assert.throws(()=>decodeVotingMember(memberAddress,memberBytes({next,vouch}).subarray(0,20)),/Truncated/)
})
test('withdrawal and discriminators reject malformed data',()=>{
 assert.equal(decodeWithdrawal(proposalAddress,withdrawalBytes()).amount,5_000_000n)
 assert.throws(()=>decodeWithdrawal(proposalAddress,withdrawalBytes().subarray(0,50)),/Truncated/)
 assert.throws(()=>decodeProposal(proposalAddress,memberBytes()),/Invalid Proposal discriminator/)
 assert.throws(()=>decodeVotingMember('invalid',memberBytes()),/Non-base58 character/)
 const b=memberBytes();b[72]=9;assert.throws(()=>decodeVotingMember(memberAddress,b),/Invalid governance enum/)
})
test('USDC parsing retains precision and rejects invalid/range inputs',()=>{
 assert.equal(parseUsdc('9007199254.740993'),9_007_199_254_740_993n)
 for(const v of ['-1','1.0000001','NaN','1e3','','18446744073709.551616'])assert.throws(()=>parseUsdc(v),/USDC|64-bit/)
})
test('required votes match critical supermajority and closure/eviction electorate rules',()=>{
 const s=snapshot(), p=s.proposals[0]
 assert.equal(requiredVotes(s.pool,p),2)
 p.action={kind:'SetSpenderLimit',member:memberAddress,cap:1n};assert.equal(requiredVotes(s.pool,p),3)
 p.action={kind:'EvictMember',member:memberAddress};assert.equal(requiredVotes(s.pool,p),2)
 p.action={kind:'ClosePool'};s.pool.metrics!.fundedMemberCount=0;assert.equal(requiredVotes(s.pool,p),3)
 p.voteThreshold=0;assert.throws(()=>requiredVotes(s.pool,p),/Invalid proposal/)
 s.pool.metrics=null;assert.throws(()=>requiredVotes(s.pool,p),/current pool account/)
})
test('lifecycle uses cycle windows, finalization and both execution delays',()=>{
 const s=snapshot(),p=s.proposals[0]
 s.pool.currentCycle=8n;assert.equal(proposalEligibility(s.pool,p,s.now).status,'Queued');assert.equal(proposalEligibility(s.pool,p,s.now).canVote,false)
 s.pool.currentCycle=9n;assert.equal(proposalEligibility(s.pool,p,s.now).status,'Open');assert.equal(proposalEligibility(s.pool,p,s.now).canVote,true);assert.equal(proposalEligibility(s.pool,p,s.now).canFinalize,false)
 p.executionMode='threshold_met';assert.equal(proposalEligibility(s.pool,p,s.now).canFinalize,true)
 p.executionMode='on_deadline';s.pool.currentCycle=10n;assert.equal(proposalEligibility(s.pool,p,s.now).canFinalize,false)
 s.pool.currentCycle=11n;assert.equal(proposalEligibility(s.pool,p,s.now).canFinalize,true);assert.equal(proposalEligibility(s.pool,p,s.now).canVote,false)
 p.state='Executable';p.executableAfter=s.now+10n;assert.equal(proposalEligibility(s.pool,p,s.now).canExecute,false);assert.equal(proposalEligibility(s.pool,p,s.now+10n).canExecute,true)
 s.pool.currentCycle=10n;assert.equal(proposalEligibility(s.pool,p,s.now+10n).canExecute,false)
 p.state='Executed';assert.equal(proposalEligibility(s.pool,p,s.now).canFinalize,false)
 p.pool=creator;assert.throws(()=>proposalEligibility(s.pool,p,s.now),/another pool/);p.pool=poolAddress;assert.throws(()=>proposalEligibility(s.pool,p,-1n),/Invalid chain time/)
})
test('vote power handles funding, maturation, eviction, closure and lock rules',()=>{
 const s=snapshot(),m=s.members[0],a:ProposalAction={kind:'ApproveWithdrawal',request:proposalAddress}
 assert.equal(votingPower(s.pool,m,a).eligible,true);m.isPaused=true;assert.equal(votingPower(s.pool,m,a).eligible,true)
 m.isMaturedVoter=false;assert.equal(votingPower(s.pool,m,a).eligible,false);assert.equal(votingPower(s.pool,m,{kind:'ClosePool'}).eligible,true)
 s.pool.metrics!.votingMemberCount=0;assert.equal(votingPower(s.pool,m,a).eligible,true)
 assert.equal(votingPower(s.pool,m,{kind:'EvictMember',member:memberAddress}).eligible,false)
 m.fundedCycle=8n;assert.equal(votingPower(s.pool,m,a).eligible,false)
 s.pool.metrics!.fundedMemberCount=0;assert.equal(votingPower(s.pool,m,{kind:'ClosePool'}).eligible,true)
 m.totalContributions=0n;assert.equal(votingPower(s.pool,m,{kind:'ClosePool'}).eligible,false)
 m.fundedCycle=9n;s.pool.metrics!.isLocked=true;assert.equal(votingPower(s.pool,m,a).eligible,false)
 m.status='Leaving';assert.equal(votingPower(s.pool,m,{kind:'ClosePool'}).eligible,false)
 assert.equal(votingPower(s.pool,undefined,a).eligible,false)
})
test('overdue cycle and rollover block governance outside testing mode',()=>{
 const s=snapshot(),p=s.proposals[0];s.pool.testingEnabled=false;s.pool.cycleStartedAt=s.now-60n;s.pool.cycleDurationSeconds=60n
 assert.equal(proposalEligibility(s.pool,p,s.now).cycleCurrent,false)
 s.pool.cycleStartedAt=s.now;s.pool.metrics!.rolloverCursor=memberAddress;assert.equal(proposalEligibility(s.pool,p,s.now).cycleCurrent,false)
})
test('action encoding validates configuration and account fields',()=>{
 const config=decodeProposal(proposalAddress,proposalBytes(2)).action
 assert.equal(encodeAction(config).length,48)
 assert.throws(()=>encodeAction({...config, voteThreshold:100} as ProposalAction),/Vote threshold/)
 assert.throws(()=>encodeAction({...config, cycleDurationSeconds:0n} as ProposalAction),/must be positive/)
 assert.throws(()=>encodeAction({...config, withdrawalExecutionMode:'invalid'} as ProposalAction),/Invalid execution mode/)
 assert.throws(()=>encodeAction({kind:'AdmitMember',candidateWallet:'invalid',vouchedBy:memberAddress}),/Non-base58 character/)
 assert.throws(()=>encodeAction({kind:'SetSpenderLimit',member:memberAddress,cap:-1n}),/64-bit/)
 assert.throws(()=>encodeAction({kind:'unknown'} as unknown as ProposalAction),/Unsupported/)
})
test('transaction create and vote use correct PDAs, instructions and privileges',()=>{
 const s=snapshot(), p=s.proposals[0]
 const tx=buildGovernanceTransaction(programId,creator,s,{kind:'create',action:{kind:'ClosePool'}})
 assert.equal(tx.instructions[0].data.toString('hex'),createHash('sha256').update('global:create_proposal').digest().subarray(0,8).toString('hex')+'03')
 assert.equal(tx.instructions[0].keys[2].pubkey.toBase58(),memberAddress);assert.equal(tx.instructions[0].keys[0].isSigner,true)
 const vote=buildGovernanceTransaction(programId,creator,s,{kind:'vote',proposal:p,approve:true}).instructions[0]
 const receipt=PublicKey.findProgramAddressSync([Buffer.from('vote'),new PublicKey(p.address).toBuffer(),new PublicKey(memberAddress).toBuffer()],new PublicKey(programId))[0]
 assert.equal(vote.keys[4].pubkey.toBase58(),receipt.toBase58());assert.equal(vote.data[8],1)
 s.receipts.push({proposal:p.address,voter:memberAddress});assert.throws(()=>buildGovernanceTransaction(programId,creator,s,{kind:'vote',proposal:p,approve:true}),/already voted/)
})
test('all six execution builders match contract account order and optional sentinels',()=>{
 for(let tag=0;tag<6;tag++){
  const s=snapshot(),p=decodeProposal(proposalAddress,proposalBytes(tag,2));s.pool.currentCycle=11n;s.members[0].fundedCycle=11n;s.pool.metrics!.headMember=memberAddress
  if(tag===1){s.withdrawals=[decodeWithdrawal(proposalAddress,withdrawalBytes())]}
  const ix=buildGovernanceTransaction(programId,creator,s,{kind:'execute',proposal:p}).instructions[0]
  const names=['execute_spender_limit','spend','execute_configuration_modification','execute_close_pool','execute_evict_member','execute_admit_member']
  assert.deepEqual(ix.data,createHash('sha256').update(`global:${names[tag]}`).digest().subarray(0,8))
  assert.equal(ix.keys[0].isSigner,true)
  assert.equal(ix.keys[tag===0||tag===2?1:2].pubkey.toBase58(),poolAddress)
  if(tag===4){assert.equal(ix.keys[5].pubkey.toBase58(),programId);assert.equal(ix.keys[7].pubkey.toBase58(),programId);assert.equal(ix.keys[5].isWritable,false)}
  if(tag===5){assert.equal(ix.keys[4].pubkey.toBase58(),memberAddress)}
  if(tag===1){assert.equal(ix.keys[6].pubkey.toBase58(),programId);assert.equal(ix.keys[8].pubkey.toBase58(),creator);assert.equal(ix.keys[10].pubkey.toBase58(),proposalAddress)}
 }
})
test('transaction builders reject ineligible actions before signing',()=>{
 const s=snapshot(),p=s.proposals[0]
 assert.throws(()=>buildGovernanceTransaction(programId,creator,s,{kind:'execute',proposal:p}),/not executable/)
 assert.throws(()=>buildGovernanceTransaction(programId,creator,s,{kind:'finalize',proposal:p}),/cannot be finalized/)
 assert.throws(()=>buildGovernanceTransaction(programId,creator,s,{kind:'vote',proposal:p,approve:'yes' as unknown as boolean}),/boolean/)
 s.members=[];assert.throws(()=>buildGovernanceTransaction(programId,creator,s,{kind:'create',action:{kind:'ClosePool'}}),/active pool membership/)
 s.pool.currentCycle=11n;p.state='Executable';p.action={kind:'ApproveWithdrawal',request:proposalAddress};assert.throws(()=>buildGovernanceTransaction(programId,creator,s,{kind:'execute',proposal:p}),/not pending/)
 p.action={kind:'EvictMember',member:memberAddress};assert.throws(()=>buildGovernanceTransaction(programId,creator,s,{kind:'execute',proposal:p}),/not an active member/)
})
test('governance fetch escalates RPC/missing account and owner failures',async()=>{
 const missing={getAccountInfo:async()=>null};await assert.rejects(()=>fetchGovernance(missing as never,programId,poolAddress),/Pool account missing/)
 const wrong={getAccountInfo:async()=>({owner:new PublicKey(creator)})};await assert.rejects(()=>fetchGovernance(wrong as never,programId,poolAddress),/owned by another program/)
 const failed={getAccountInfo:async()=>{throw new Error('RPC unavailable')}};await assert.rejects(()=>fetchGovernance(failed as never,programId,poolAddress),/RPC unavailable/)
 await assert.rejects(()=>fetchGovernance(missing as never,'invalid',poolAddress),/Non-base58 character/)
})

test('admission uses proposer wallet for vouch and resolves inviter member at execution',()=>{
 const s=snapshot(), action:ProposalAction={kind:'AdmitMember',candidateWallet:poolAddress,vouchedBy:creator}
 const tx=buildGovernanceTransaction(programId,creator,s,{kind:'create',action})
 assert.equal(tx.instructions[0].data.subarray(41).toString('hex'),new PublicKey(creator).toBuffer().toString('hex'))
 assert.throws(()=>buildGovernanceTransaction(programId,creator,s,{kind:'create',action:{...action,vouchedBy:memberAddress}}),/own wallet address/)
 assert.throws(()=>buildGovernanceTransaction(programId,creator,s,{kind:'create',action:{...action,candidateWallet:creator}}),/Candidate must/)
 s.pool.metrics!.admissionMode='Open';assert.throws(()=>buildGovernanceTransaction(programId,creator,s,{kind:'create',action}),/Open pools/)
 s.pool.metrics!.admissionMode='InviteVouched';s.pool.memberCap=s.pool.memberCount;assert.throws(()=>buildGovernanceTransaction(programId,creator,s,{kind:'create',action}),/capacity reached/)
 const p=decodeProposal(proposalAddress,proposalBytes(5,2));s.pool.currentCycle=11n;s.members=[]
 assert.throws(()=>buildGovernanceTransaction(programId,creator,s,{kind:'execute',proposal:p}),/Inviter is not/)
})
test('self eviction proposals reject before signing',()=>{
 const s=snapshot();assert.throws(()=>buildGovernanceTransaction(programId,creator,s,{kind:'create',action:{kind:'EvictMember',member:memberAddress}}),/own eviction/)
})
