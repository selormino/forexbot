const db=require('./db');

function sigmoid(z){return 1/(1+Math.exp(-Math.max(-30,Math.min(30,z))));}
function dot(w,x){let s=w[0]||0; for(let i=0;i<x.length;i++) s+=(w[i+1]||0)*x[i]; return s;}
function train(rows, epochs=900, lr=0.04, l2=0.0008){
  if(rows.length<30) throw new Error('At least 30 labeled observations are required.');
  const n=rows[0].x.length,w=new Array(n+1).fill(0); for(let e=0;e<epochs;e++){for(const r of rows){const p=sigmoid(dot(w,r.x)),g=p-r.y;w[0]-=lr*g;for(let j=0;j<n;j++)w[j+1]-=lr*(g*r.x[j]+l2*w[j+1]);}}
  return {weights:w,features:n};
}
function evaluate(model,rows){let c=0,logloss=0;for(const r of rows){const p=sigmoid(dot(model.weights,r.x));c+=((p>=.5?1:0)===r.y);logloss+=-(r.y*Math.log(p+1e-9)+(1-r.y)*Math.log(1-p+1e-9));}return {accuracy:c/rows.length,logLoss:logloss/rows.length,samples:rows.length};}
function latest(){const row=db.prepare('SELECT * FROM models ORDER BY id DESC LIMIT 1').get();return row?JSON.parse(row.model_json):null;}
function save(model,metrics){db.prepare('INSERT INTO models(created_at,model_json,metrics_json) VALUES(?,?,?)').run(Date.now(),JSON.stringify(model),JSON.stringify(metrics));}
function trainFromDb(){const rows=db.prepare('SELECT features,label FROM observations WHERE label IS NOT NULL ORDER BY ts').all().map(r=>({x:JSON.parse(r.features),y:r.label}));const split=Math.floor(rows.length*.8);const model=train(rows.slice(0,split));const metrics={train:evaluate(model,rows.slice(0,split)),test:evaluate(model,rows.slice(split))};save(model,metrics);return {model,metrics};}
module.exports={sigmoid,train,evaluate,latest,save,trainFromDb};
