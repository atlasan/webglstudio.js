console.log("Mitsuba WebSocket Server\n**************************");

//SETTINGS
var port = 9003;
var max_clients = parseInt( process.env.MITSUBA_MAX_CLIENTS || "4" );

//origins (editor hosts) allowed to connect, comma separated, e.g. "https://myserver.com,http://localhost:8000"
//use "*" to allow any origin (NOT recommended: anyone could use this machine to run renders)
var allowed_origins = ( process.env.MITSUBA_ALLOWED_ORIGINS || "" ).split(",").map( function(v){ return v.trim(); } ).filter( Boolean );

var index = process.argv.indexOf("-p");
if(index != -1)
	port = parseInt( process.argv[ index + 1 ] );

index = process.argv.indexOf("-o");
if(index != -1)
	allowed_origins = process.argv[ index + 1 ].split(",").map( function(v){ return v.trim(); } ).filter( Boolean );

if(!allowed_origins.length)
	console.log("Warning: no allowed origins set (MITSUBA_ALLOWED_ORIGINS or -o), all WebSocket connections will be rejected.");

function isOriginAllowed( origin )
{
	if( allowed_origins.indexOf("*") != -1 )
		return true;
	return !!origin && allowed_origins.indexOf( origin ) != -1;
}

//CREATE GAME *********************
var Mitsuba = require("./mitsuba.js");

//LAUNCH SERVER ***********************
var http = require('http');
var url = require('url');

//HTTP REQUESTS
var server = http.createServer( function(request, response) {

	response.setHeader('Access-Control-Allow-Origin', '*');
	response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	console.log("REQUEST: " + request.url );

	var url_info = url.parse( request.url, true ); //all the request info is here
	var pathname = url_info.pathname; //the address
	var params = url_info.query; //the parameters
	Mitsuba.onRequest( request, response );
});

server.on("error", function(err){
	if( err.code == "EADDRINUSE" )
		console.log("Error: Port ",port," is in use.");
	else
		console.log("Error:", err );
	process.exit(1);
});

server.listen( port, function() {
	console.log("Server ready in port", port );
});

//WS REQUESTS
var WebSocketServer = require('websocket').server;
wsServer = new WebSocketServer({ // create the server
    httpServer: server //if we already have our HTTPServer in server variable...
});
wsServer.on('request', function(request) {
	//only accept connections coming from known editors
	if( !isOriginAllowed( request.origin ) )
	{
		console.log("Connection rejected from origin:", request.origin );
		request.reject( 403, "Origin not allowed" );
		return;
	}

	if( Mitsuba.clients.length >= max_clients )
	{
		console.log("Connection rejected, too many clients" );
		request.reject( 503, "Server busy" );
		return;
	}

    var connection = request.accept( null, request.origin );

	//create client
	var client = Mitsuba.onClientJoin( connection, request.origin );

	//when users send message
    connection.on('message', function( message ) {
		if( message.type == "utf8" )
		{
			var msg = null;
			try
			{
				msg = JSON.parse( message.utf8Data );
			}
			catch (err)
			{
				client.error("invalid JSON message");
				return;
			}
			if( !msg || msg.constructor !== Object || typeof(msg.action) != "string" )
			{
				client.error("invalid message");
				return;
			}
			try
			{
				client.onMessage( msg );
			}
			catch (err)
			{
				console.error( "Error processing message:", err );
				client.error("error processing message");
			}
		}
		else if( message.type == "binary" )
			client.onBinary( message.binaryData );
		else
			console.log("unknown message format:", message.type );
    });

	//user leaves
    connection.on('close', function(reason) {
		if(reason == 1009)
			console.log("connection closed: data too long");
		console.log("User gone, close code:",reason);// close user connection
		Mitsuba.onClientLeave( client );
    });
});


//START GAME ******************************
Mitsuba.start();

//input
/* this causes problem in nohup mode
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});


rl.on('line', (answer) => {
  MAZrServer.onCommand( answer );
});
rl.on('pause', () => {
  MAZrServer.finish();
  server.close();
  rl.close();
  process.exit();
});
*/