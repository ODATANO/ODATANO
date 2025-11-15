const request = require('supertest');
const cds = require('@sap/cds');

let app;
beforeAll(async () => {
 await cds.load(__dirname + '/../../');
 app = await cds.connect.to('CardanoODataService');
});

describe('Cardano OData API', () => {
 test('GET /Transactions - Valid Hash', async () => {
 const res = await request(app)
 .get("/odata/v4/CardanoODataService/Transactions(ID='50d9ad6558a6963d72dc25b4f37f31db15a512c708bb735a8f67f30b878bd4e3')")
 .expect(200);
 expect(res.body).toHaveProperty('hash');
 expect(res.body.hash).toBe('50d9ad6558a6963d72dc25b4f37f31db15a512c708bb735a8f67f30b878bd4e3');
 });

 test('GET /Addresses - Valid Address', async () => {
 const res = await request(app)
 .get("/odata/v4/CardanoODataService/Addresses(address='addr_test1vpqgsp5z7k0v4z5j5x5c5q5f5g5h5j5k5l5m5n5p5q5r5s5t5u5v5w5x5y5z')")
 .expect(200);
 expect(res.body).toHaveProperty('address');
 expect(res.body.address).toBe('addr_test1vpqgsp5z7k0v4z5j5x5c5q5f5g5h5j5k5l5m5n5p5q5r5s5t5u5v5w5x5y5z');
 expect(res.body).toHaveProperty('balance');
 }); 
});