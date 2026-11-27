<?php

// Deployer settings
// copy this file as config.php and change the key

$KEY = ""; //set validation key (used as pass to allow deploying to this folder) MUST BE SET TO SOMETHING. Letters and numbers only, use a long random one
$BASE_DEPLOY_FOLDER = ""; //folder relative to this script where all deploys will be done. MUST BE SET, e.g. "deploy"
$IGNORE_EXTENSIONS = "php,asp,jsp,vbs,exe,cgi,py"; //extra file formats not allowed to be uploaded to the machine. Server-side script types (php, phtml, phar, cgi, .htaccess...) are always blocked by deployer.php

?>
