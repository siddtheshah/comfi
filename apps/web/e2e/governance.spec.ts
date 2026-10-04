import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { Keypair, PublicKey } from '@solana/web3.js'
import { poolBytes, poolAddress, creator } from '../test/fixtures/pool'
import { memberAddress, proposalAddress, proposalBytes, memberBytes, programId, withdrawalBytes } from '../test/fixtures/governance'
const account = (bytes: Buffer) => ({ data: [bytes.toString('base64'),'base64'], executable:false, lamports:10000000, owner:programId, rentEpoch:0, space:bytes.length })
async function setup(page: Page, signing = false) {
  const keypair = Keypair.fromSeed(new Uint8Array(32).fill(7))
  const walletAddress = signing ? keypair.publicKey.toBase58() : creator
  const walletMember = PublicKey.findProgramAddressSync([Buffer.from('member'),new PublicKey(poolAddress).toBuffer(),new PublicKey(walletAddress).toBuffer()],new PublicKey(programId))[0].toBase58()
  const member = memberBytes();new PublicKey(walletAddress).toBuffer().copy(member,40)
  let broadcasts=0
  const pool = poolBytes({locked:false})
  pool.writeUInt32LE(5001,136)
  let proposals = [proposalBytes(3,0)]
  await page.addInitScript(({ address, secret }) => {
    Object.assign(window, { solana: { isPhantom:true, connect:async()=>({publicKey:{toBase58:()=>address}}), disconnect:async()=>{}, on:()=>{}, removeListener:()=>{}, signTransaction:async()=>{throw new Error('User rejected governance transaction.')} } })
      Object.assign(window, { governanceSecret: secret })
  }, { address: walletAddress, secret: Array.from(keypair.secretKey) })
  await page.route('**/__comfi/mock-wallet/pools',route=>route.fulfill({json:{pools:[{address:poolAddress,data:pool.toString('base64'),vaultBalanceAtomic:'100000000'}]}}))
  await page.route('http://127.0.0.1:8899/',route=>{
    const { method, params, id }=route.request().postDataJSON()
    let result: unknown
    switch(method) {
      case 'getHealth':result='ok';break
      case 'sendTransaction':broadcasts++;return route.fulfill({json:{jsonrpc:'2.0',id,error:{code:-32000,message:'Unexpected transaction broadcast'}}})
      case 'getAccountInfo':result={context:{slot:1},value:account(pool)};break
      case 'getTokenAccountBalance':result={context:{slot:1},value:{amount:'100000000',decimals:6,uiAmount:100}};break
      case 'getSlot':result=1;break
      case 'getBlockTime':result=1790000000;break
      case 'getLatestBlockhash':result={context:{slot:1},value:{blockhash:creator,lastValidBlockHeight:1000}};break
      case 'getProgramAccounts': {
        const discriminator=params[1].filters[0].memcmp.bytes
        // Compare raw 8-byte discriminator through a tiny independent encoder.
        const encode=(bytes:Buffer)=>{let n=BigInt('0x'+bytes.toString('hex')),s='';const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';while(n){s=alphabet[Number(n%58n)]+s;n/=58n}return s}
        const disc=(name:string)=>encode(createHash('sha256').update(`account:${name}`).digest().subarray(0,8))
        if(discriminator===disc('Proposal'))result=proposals.map((b,i)=>({pubkey:i===0?proposalAddress:PublicKey.findProgramAddressSync([Buffer.from('proposal'),new PublicKey(poolAddress).toBuffer(),Buffer.from([i,0,0,0,0,0,0,0])],new PublicKey(programId))[0].toBase58(),account:account(b)}))
        else if(discriminator===disc('Member'))result=[{pubkey:walletMember,account:account(member)}]
        else if(discriminator===disc('WithdrawalRequest'))result=[{pubkey:proposalAddress,account:account(withdrawalBytes())}]
        else result=[]
        break
      }
      default: return route.fulfill({json:{jsonrpc:'2.0',id,error:{code:-32601,message:`Unhandled test RPC: ${method}`}}})
    }
    return route.fulfill({json:{jsonrpc:'2.0',id,result}})
  })
  await page.goto('/')
  await page.getByTestId('pool-pool-0').click()
  await expect(page.getByRole('heading',{name:'Governance & proposals'})).toBeVisible()
  return { getBroadcasts:()=>broadcasts, setProposals: (next:Buffer[])=>{proposals=next} }
}
async function connect(page:Page){
 await page.getByRole('button',{name:'⚡ ComFi Wallet',exact:true}).click()
 await page.getByRole('button',{name:'Phantom',exact:true}).click()
 await page.getByRole('button',{name:'Connect Phantom',exact:true}).click()
 await page.getByRole('button',{name:'Done',exact:true}).click()
}
test('governance displays chain lifecycle, voting breakdown and rejected signatures',async({page})=>{
 await setup(page);await connect(page)
 await expect(page.locator('.governance-proposal .tag')).toHaveText('Open')
 await page.getByRole('button',{name:'Vote',exact:true}).click()
 const dialog=page.getByRole('dialog')
 await expect(dialog).toContainText('3 cycles');await expect(dialog).toContainText('1 member = 1 vote')
 await page.screenshot({path:'/tmp/comfi-governance-verification/vote.png',fullPage:true})
 await dialog.getByRole('button',{name:'Vote YES',exact:true}).click()
 await expect(dialog.getByRole('alert')).toHaveText('User rejected governance transaction.')
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click()
 await page.getByRole('button',{name:'Create Proposal',exact:true}).click()
 await expect(page.getByRole('dialog').getByLabel('Proposal type').locator('option')).toHaveCount(6)
 await page.getByRole('dialog').getByLabel('Proposal type').selectOption('ConfigurationModification')
 await page.screenshot({path:'/tmp/comfi-governance-verification/create.png',fullPage:true})
 await page.getByRole('dialog').getByLabel('voteThreshold',{exact:true}).fill('100')
 await page.getByRole('dialog').getByRole('button',{name:'Submit proposal',exact:true}).click()
 await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Vote threshold must be 5001')
})
test('all six actions and terminal states display; governance fits mobile',async({page})=>{
 const fixture=await setup(page)
 fixture.setProposals([proposalBytes(0,0),proposalBytes(1,2),proposalBytes(2,3),proposalBytes(3,4),proposalBytes(4,0),proposalBytes(5,0)])
 await connect(page)
 await expect(page.locator('.governance-proposal')).toHaveCount(6)
 await expect(page.locator('.governance-proposal .tag')).toHaveText(['Open','Executable','Executed','Rejected','Open','Open'])
 await page.screenshot({path:'/tmp/comfi-governance-verification/list.png',fullPage:true})
 await page.setViewportSize({width:390,height:844})
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
 await page.getByRole('button',{name:'Create Proposal',exact:true}).click()
 await page.getByRole('dialog').getByLabel('Proposal type').selectOption('AdmitMember')
 await expect(page.getByRole('dialog').getByLabel('Candidate wallet')).toBeVisible()
 await page.screenshot({path:'/tmp/comfi-governance-verification/mobile.png',fullPage:true})
})
test('network change during approval prevents transaction broadcast',async({page})=>{
 const fixture=await setup(page,true);await connect(page)
 await page.evaluate(()=>{(window as any).solana.signTransaction=async(tx:any)=>new Promise(resolve=>{(window as any).releaseSignature=()=>{tx.partialSign({publicKey:tx.feePayer,secretKey:new Uint8Array((window as any).governanceSecret)});resolve(tx)}})})
 let broadcasts=0
 await page.route('https://api.devnet.solana.com/',route=>{if(route.request().postDataJSON().method==='sendTransaction')broadcasts++;return route.fulfill({json:{jsonrpc:'2.0',id:route.request().postDataJSON().id,result:route.request().postDataJSON().method==='getProgramAccounts'?[]:'ok'}})})
 await page.getByRole('button',{name:'Vote',exact:true}).click();await page.getByRole('button',{name:'Vote YES',exact:true}).click()
 await page.waitForFunction(()=>typeof (window as any).releaseSignature==='function')
 await page.evaluate(()=>{const select=document.querySelector('select[aria-label="Solana network"]') as HTMLSelectElement;select.value='devnet';select.dispatchEvent(new Event('change',{bubbles:true}))})
 await expect(page.getByTestId('localnet-wallet')).toContainText('api.devnet.solana.com')
 await page.evaluate(()=>(window as any).releaseSignature())
 await expect(page.getByRole('dialog')).toHaveCount(0)
 expect(broadcasts+fixture.getBroadcasts()).toBe(0)
})
