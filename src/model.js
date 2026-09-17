const db=require('./db');

function sigmoid(z){return 1/(1+Math.exp(-Math.max(-30,Math.min(30,z))));}
function dot(w,x){let s=w[0]||0;for(let i=0;i<x.length;i++)s+=(w[i+1]||0)*x[i];return s;}
function train(rows,epochs=1200,lr=0.025,l2=0.001){
  if(rows.length<60)throw new Error('At least 60 labeled observations are required.');
  const n=rows[0].x.length,w=new Array(n+1).fill(0);
  for(let e=0;e<epochs;e++)for(const r of rows){const p=sigmoid(dot(w,r.x)),g=p-r.y;w[0]-=lr*g;for(let j=0;j<n;j++)w[j+1]-=lr*(g*r.x[j]+l2*w[j+1]);}
  return {weights:w,features:n,algorithm:'logistic-regression',trainedAt:new Date().toISOString()};
}
function evaluate(model,rows){if(!rows.length)return {accuracy:null,logLoss:null,samples:0};let c=0,ll=0;for(const r of rows){const p=sigmoid(dot(model.weights,r.x));c+=((p>=.5?1:0)===r.y);ll+=-(r.y*Math.log(p+1e-9)+(1-r.y)*Math.log(1-p+1e-9));}return {accuracy:c/rows.length,logLoss:ll/rows.length,samples:rows.length};}
function latest(){const row=db.prepare('SELECT * FROM models ORDER BY id DESC LIMIT 1').get();return row?JSON.parse(row.model_json):null;}
function save(model,metrics){db.prepare('INSERT INTO models(created_at,model_json,metrics_json) VALUES(?,?,?)').run(Date.now(),JSON.stringify(model),JSON.stringify(metrics));}
function trainFromDb(){
  const rows=db.prepare('SELECT features,label,ts FROM observations WHERE label IS NOT NULL ORDER BY ts ASC').all().map(r=>({x:JSON.parse(r.features),y:Number(r.label),ts:r.ts}));
  if(rows.length<60)throw new Error(`Need 60 labeled observations; currently have ${rows.length}.`);
  const split=Math.max(48,Math.floor(rows.length*.8));
  const trainRows=rows.slice(0,split),testRows=rows.slice(split);
  const candidate=train(trainRows),metrics={train:evaluate(candidate,trainRows),test:evaluate(candidate,testRows),split:'time-ordered 80/20'};
  const previous=latest();
  const promoted=!previous||((metrics.test.accuracy??0)>=(previous.metrics?.test?.accuracy??0)-0.01 && (metrics.test.logLoss??99)<=(previous.metrics?.test?.logLoss??99)+0.03);
  if(promoted)save(candidate,metrics);
  return {promoted,model:candidate,metrics};
}
module.exports={sigmoid,dot,train,evaluate,latest,save,trainFromDb};
